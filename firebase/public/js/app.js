/* UI orchestration: display evidence, model decisions, catalog risk, and verified simulator state. Label offline results and simulation boundaries. */

import { diagnose, patrol, DEFAULT_MODEL } from './ai.js';
import { preAnalyze, normalizeEvidence, ruleBasedTriage, compareWithExpected } from './triage.js';
import { nodeSignals } from './tools.js';
import * as clusterApi from './cluster.js';
import {
  RISK_LEVELS, RISK_ORDER, DISCOURAGED_ACTIONS, ACTION_LIST,
  buildApprovalPlan, validateApproval, buildExecPackage,
} from './actions.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => `${Math.round(Number(v || 0) * 100)}%`;
const clock = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return iso || '';
  }
};

// ======================================================================
// State
// ======================================================================
/* Version the output cache to exclude results from older language and schema versions. */
const CACHE_KEY = 'triage:cache:v3';

const S = {
  cases: [],
  current: null,
  result: null,
  pre: null,
  approvals: {},
  ticket: '',
  approver: '',
  /* AI output cache for repeated case runs. */
  cache: loadCache(),
  /* Structured AI decisions accumulated by case ID. */
  benchAi: {},
};

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(S.cache));
  } catch {
    /* Storage may be unavailable; caching is optional. */
  }
}

function setStatus(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

// ======================================================================
// Tabs
// ======================================================================
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    for (const b of $('#tabs').querySelectorAll('button')) b.classList.toggle('on', b === btn);
    for (const t of document.querySelectorAll('.tab')) t.hidden = true;
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    if (panel) panel.hidden = false;
    if (btn.dataset.tab === 'patrol') refreshCluster();
    if (btn.dataset.tab === 'bench') renderBenchTable();
  });
}

// ======================================================================
// Case triage
// ======================================================================
async function loadCases() {
  const res = await fetch('./data/cases.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load cases HTTP ${res.status}`);
  const doc = await res.json();
  S.cases = doc.cases || [];
  const sel = $('#case-select');
  sel.innerHTML = S.cases
    .map((c) => `<option value="${esc(c.id)}">${esc(c.title || c.id)}</option>`)
    .join('');
}

function currentCase() {
  return S.cases.find((c) => c.id === $('#case-select').value) || S.cases[0];
}

async function runCase({ ignoreCache = false } = {}) {
  const c = currentCase();
  if (!c) return;
  const btn = $('#run-case');
  btn.disabled = true;
  $('#tab-case').dataset.state = 'running';
  S.current = c;
  S.approvals = {};
  S.ticket = '';
  S.approver = '';

  const evidence = normalizeEvidence(c);
  S.pre = preAnalyze(evidence);

  // Render deterministic evidence before waiting for the model.
  renderEvidence(evidence, S.pre);
  renderVerdictFromRule(evidence, S.pre);
  $('#case-result').style.display = 'block';
  $('#tools').innerHTML = '';
  $('#aitext').textContent = '';
  $('#degradereason').style.display = 'none';

  // Reuse only results in the current cache namespace.
  const hit = !ignoreCache && S.cache[c.id];
  if (hit) {
    S.result = hit;
    S.result.fromCache = true;
    noteAiVerdict(c, hit);
    renderAll(c, evidence);
    setStatus('#case-status', 'Using cached result (no model quota used)');
    $('#tab-case').dataset.state = 'complete';
    btn.disabled = false;
    return;
  }

  setStatus('#case-status', `Local pre-analysis complete; waiting for ${DEFAULT_MODEL}…`);
  try {
    const out = await diagnose({
      caseObj: c,
      onProgress: (msg) => setStatus('#case-status', msg),
    });
    S.result = out;
    S.cache[c.id] = out;
    saveCache();
    noteAiVerdict(c, out);
    renderAll(c, evidence);
    setStatus('#case-status', out.mode === 'gemini' ? 'Complete' : 'Complete (offline fallback)');
    $('#tab-case').dataset.state = 'complete';
  } catch (err) {
    setStatus('#case-status', `Failed: ${err.message}`);
    $('#tab-case').dataset.state = 'failed';
  } finally {
    btn.disabled = false;
  }
}

/* Accumulate structured model decisions for benchmark comparison. */
function noteAiVerdict(c, out) {
  const v = extractVerdict(out);
  const cmp = v && compareWithExpected({ class: v.class, should_rma: v.should_rma }, c.expected);
  if (cmp) S.benchAi[c.id] = { ...v, ...cmp };
}

/* Read conclusions only from registered structured recommendations. */
function extractVerdict(out) {
  const a = (out?.actions || [])[0];
  if (!a) return null;
  return {
    class: a.classification,
    class_label: a.classification_label,
    should_rma: a.should_rma,
    confidence: a.confidence,
    action_label: a.action_label,
  };
}

function renderVerdictFromRule(evidence, pre) {
  const r = ruleBasedTriage(evidence, pre);
  const expected = S.current?.expected;
  $('#verdict-mode').textContent = 'Rule baseline; awaiting model decision';
  $('#verdict').className = `verdict ${r.should_rma ? 'rma' : 'norma'}`;
  $('#verdict').innerHTML = `
    <div class="big">
      <div class="lbl">Hardware repair</div>
      <div class="val">${r.should_rma ? 'Repair recommended' : 'Repair not recommended'}</div>
      <div class="lbl" style="margin-top:8px">Rule baseline · Confidence ${pct(r.confidence)}</div>
    </div>
    <div class="meta">
      <div class="row"><span class="k">Classification</span><span>${esc(r.class)}</span></div>
      <div class="row"><span class="k">Rule evidence</span><span class="hint">${esc(r.basis.join('; ') || '(no matching evidence)')}</span></div>
      <div class="row"><span class="k">Scope</span><span class="hint">${esc(r.note)}</span></div>
      ${expected ? `<div class="row"><span class="k">Expected decision</span><span class="hint">${esc(expected.class)} · ${expected.should_rma ? 'Repair' : 'No repair'}</span></div>` : ''}
    </div>`;
}

function renderAll(c, evidence) {
  const out = S.result;
  const v = extractVerdict(out);
  renderVerdict(out, v, c);
  renderTools(out);
  renderActions(out);
  $('#aitext').textContent = out.text || '';
  $('#case-result').style.display = 'block';
}

function renderVerdict(out, v, c) {
  // Describe tool use from recorded calls, not model mode alone.
  const nCalls = (out.tool_calls || []).length;
  const modeNote = {
    gemini: nCalls
      ? `${out.model} with ${nCalls} tool calls`
      : `${out.model} direct response; no tool calls`,
    fallback: 'Model requests failed; using offline rule baseline',
    offline: 'Offline rule baseline; no model used',
  }[out.mode] || out.mode;
  const degraded = (out.degraded || []).length
    ? ` · Fallback from ${out.degraded.map((d) => d.model).join(', ')}`
    : '';
  $('#verdict-mode').textContent = `(${modeNote}${degraded})${out.fromCache ? ' · Local cache' : ''}`;

  if (out.degraded?.length) {
    $('#degradereason').style.display = 'block';
    // Show failures for every attempted model, including when all fail.
    $('#degradereason').innerHTML =
      'Model failures: ' + out.degraded.map((d) => `<b>${esc(d.model)}</b> - ${esc(d.reason)}`).join(' ｜ ');
  }

  if (!v) {
    // Do not infer a structured decision from unstructured model text.
    $('#verdict').className = 'verdict';
    $('#verdict').innerHTML = `
      <div class="big"><div class="lbl">Hardware repair</div><div class="val">Not registered</div></div>
      <div class="meta">
        <div class="row"><span class="k">Details</span>
          <span class="hint">The model did not use <code>propose_fix</code> to register a structured decision.
          No verifiable classification or repair decision is available. The rule baseline does not analyze trends or causal chains.
          <b>Evidence may be insufficient for a firm decision.</b></span></div>
      </div>`;
    return;
  }

  const expected = c?.expected;
  const agreeClass = expected && v.class === expected.class;
  const agreeRma = expected && Boolean(v.should_rma) === Boolean(expected.should_rma);
  const conf = Number(v.confidence || 0);

  $('#verdict').className = `verdict ${v.should_rma ? 'rma' : 'norma'}`;
  $('#verdict').innerHTML = `
    <div class="big">
      <div class="lbl">Hardware repair</div>
      <div class="val">${v.should_rma ? 'Repair required' : 'Repair not required'}</div>
      <div class="lbl" style="margin-top:8px">Model confidence ${pct(conf)}</div>
    </div>
    <div class="meta">
      <div class="row"><span class="k">Classification</span><span class="strong">${esc(v.class_label || v.class)}</span></div>
      <div class="row"><span class="k">Confidence</span>
        <span><span class="confbar"><i style="width:${Math.round(conf * 100)}%"></i></span></span></div>
      ${expected ? `<div class="row"><span class="k">Expected decision</span>
        <span>${esc(expected.class)} · ${expected.should_rma ? 'Repair' : 'No repair'}
        ${agreeClass && agreeRma ? '<span class="chip" style="color:var(--ok);border-color:var(--ok)">Matches expectations</span>'
          : '<span class="chip" style="color:var(--warn);border-color:var(--warn)">Differs from expectations</span>'}</span></div>` : ''}
      <div class="row"><span class="k">Diagnostic challenge</span>
        <span class="hint">${esc(expected?.trap || '--')}</span></div>
    </div>`;
}

function renderEvidence(evidence, pre) {
  const c = pre.confirmed;
  const tel = evidence.node_telemetry || {};
  const items = [];

  items.push(['Original error text', `<pre class="cmd" style="margin:0">${esc(String(evidence.stderr_excerpt || '(none)').slice(0, 900))}</pre>`, '']);

  const env = evidence.environment || {};
  items.push([
    'Environment versions',
    Object.entries(env).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('<br>') || '(not supplied)',
    c.compat_ok === false ? 'bad' : 'good',
  ]);

  items.push([
    'Detected Xid codes',
    c.xids.length
      ? c.xids.map((x) => `Xid ${x.code} ×${x.count} ${x.known ? esc(x.name) : '<b>No knowledge-base record</b>'}`).join('<br>')
      : 'None detected',
    c.xids.some((x) => !x.known) ? 'bad' : '',
  ]);

  items.push(['Matched signatures', c.signatures.length ? c.signatures.map((s) => esc(s.label)).join('<br>') : 'No matches', '']);

  if (c.memory_fit) {
    items.push([
      'GPU memory estimate',
      `${c.memory_required_gb} GB / Capacity ${c.memory_capacity_gb} GB<br>Result <b>${esc(c.memory_fit)}</b>`,
      c.memory_fit === 'will_oom' ? 'bad' : 'good',
    ]);
  }

  items.push(['Compatibility check', c.compat_ok ? 'Compatible version stack' : esc((c.compat_issues || []).join('; ')), c.compat_ok ? 'good' : 'bad']);

  const evt = (tel.xid_events || []);
  if (evt.length) {
    items.push([
      'Node telemetry · Xid events',
      evt.map((e) => `Xid ${e.code}${e.gpu !== undefined ? ` · GPU ${e.gpu}` : ''}${e.at ? ` · ${esc(e.at)}` : ''}${e.count ? ` ×${e.count}` : ''}`).join('<br>'),
      '',
    ]);
  }
  if (tel.history_30d) {
    items.push([
      'Node telemetry · 30-day trend',
      `Xid 94 total <b>${tel.history_30d.xid94_count}</b> events<br>Correctable ECC trend <b>${esc(tel.history_30d.ecc_correctable_trend)}</b>`,
      tel.history_30d.ecc_correctable_trend === 'rising' ? 'bad' : '',
    ]);
  }
  if (tel.ecc_uncorrectable !== undefined) {
    items.push(['ECC', `Uncorrectable ${tel.ecc_uncorrectable} Correctable ${tel.ecc_correctable}`, tel.ecc_uncorrectable > 0 ? 'bad' : '']);
  }

  $('#evidence').innerHTML = `<div class="grid">${items
    .map(([k, v, cls]) => `<div class="ev"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`)
    .join('')}</div>`;

  $('#verdict-mode').dataset.evidenceReady = '1';
}

/* Share the tool trace renderer between case triage and patrol. */
function toolTraceHtml(out) {
  const calls = out.tool_calls || [];
  const refs = (out.citations || [])
    .map((c) => `${c.ref} = ${c.source}`)
    .join(' ');
  let html;
  if (calls.length) {
    html = calls
      .map((c) => `<li><b>${esc(c.name)}</b><span>${esc(JSON.stringify(c.args))}</span></li>`)
      .join('') + (refs ? `<li><b>Reference map</b><span>${esc(refs)}</span></li>` : '');
  } else if (out.pipeline_error || refs) {
    // Citations without call records indicate an incomplete pipeline; show the error.
    html = `<li class="fail"><b>Pipeline error</b><span>`
      + esc(out.pipeline_error || `${(out.citations || []).length} tool references (${refs}) exist without call records.`)
      + `</span></li>`;
  } else {
    html = '<li><span>No tool calls: output came from offline rules or a direct model response.</span></li>';
  }
  if (out.error) html += `<li><b>Error</b><span>${esc(out.error)}</span></li>`;
  return { calls, html };
}

function toolCountText(calls) {
  return calls.length ? `${calls.length} tool calls` : '(no tool calls)';
}

function renderTools(out) {
  const { calls, html } = toolTraceHtml(out);
  $('#toolcount').textContent = toolCountText(calls);
  $('#tools').innerHTML = html;
}
function renderActions(out) {
  const actions = out.actions || [];
  const box = $('#actions');
  if (!actions.length) {
    box.innerHTML = '<div class="hint">No action recommendations registered.</div>';
    $('#approval-global').innerHTML = '';
    $('#acts-hint').textContent = '';
    return;
  }

  $('#acts-hint').textContent = `${actions.length} actions, ordered by risk`;

  // Group actions by risk so approval requirements remain visible.
  const order = { low: 0, medium: 1, high: 2 };
  const sorted = actions.slice().sort((a, b) => (order[a.risk] ?? 9) - (order[b.risk] ?? 9));

  box.innerHTML = sorted.map((a) => actionCard(a)).join('');
  box.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const d = btn.dataset.act;
      S.approvals[id] = { ...(S.approvals[id] || {}), decision: d, decidedAt: new Date().toISOString() };
      renderActions(S.result);
      renderApprovalBar();
    });
  });
  box.querySelectorAll('input[data-ack]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.ack;
      S.approvals[id] = { ...(S.approvals[id] || {}), impact_ack: chk.checked };
      renderApprovalBar();
    });
  });

  renderApprovalBar();
}

function actionCard(a) {
  const st = S.approvals[a.id] || {};
  const cls = [a.risk, st.decision === 'approve' ? 'done' : '', st.decision === 'reject' ? 'rejected' : '']
    .filter(Boolean)
    .join(' ');
  const refs = (a.evidence_refs || []).map((r) => `<span class="chip ref">${esc(r)}</span>`).join('');

  const needAck = a.risk === 'medium' && st.decision === 'approve';
  const isPending = !st.decision;

  return `
  <div class="act ${cls}">
    <div class="hd">
      <span class="badge ${a.risk}">${esc(a.risk_label || a.risk)}</span>
      <span class="t">${esc(a.action_label || a.title)}</span>
      ${refs}
      ${a.should_rma === true ? '<span class="badge high">Repair recommended</span>' : ''}
      ${a.should_rma === false ? '<span class="badge info">Repair not recommended</span>' : ''}
      <span class="chip">Confidence ${pct(a.confidence)}</span>
    </div>
    <div class="d">${esc(a.detail || '')}</div>
    <div class="rows">
      <div>Impact: <b>${esc(a.affects || '-')}</b></div>
      <div>Approval: <b>${esc(a.approval_requirement || RISK_LEVELS[a.risk]?.approval || '-')}</b></div>
      ${a.cmds?.length ? `<div>Command: <code>${esc(a.cmds[0])}</code>${a.cmds.length > 1 ? ` <span class="hint">(${a.cmds.length} lines; see execution package)</span>` : ''}</div>` : ''}
      ${a.rollback ? `<div>Rollback: <b>${esc(a.rollback)}</b></div>` : '<div style="color:var(--warn)">No rollback plan; excluded from execution package</div>'}
      ${a.note ? `<div class="hint">${esc(a.note)}</div>` : ''}
      ${a.evidence ? `<div class="hint">Evidence: ${esc(a.evidence)}</div>` : ''}
    </div>
    <div class="acts-actions">
      ${isPending ? `<button class="mini accept" data-act="approve" data-id="${esc(a.id)}">Approve</button>
                     <button class="mini reject" data-act="reject" data-id="${esc(a.id)}">Reject</button>`
        : `<span class="chip">${st.decision === 'approve' ? 'Approved' : 'Rejected'} · ${esc(clock(st.decidedAt))}</span>
           <button class="mini ghost" data-act="reset" data-id="${esc(a.id)}">Undo</button>`}
      ${needAck ? `<label class="chk"><input type="checkbox" data-ack="${esc(a.id)}" ${st.impact_ack ? 'checked' : ''}>
        I acknowledge the impact on other tasks on this node</label>` : ''}
    </div>
  </div>`;
}

function renderApprovalBar() {
  const actions = S.result?.actions || [];
  const ids = actions.map((a) => a.action_id).filter(Boolean);
  const plan = buildApprovalPlan(ids);
  const approved = actions.filter((a) => S.approvals[a.id]?.decision === 'approve');
  const rejected = actions.filter((a) => S.approvals[a.id]?.decision === 'reject');
  const pending = actions.length - approved.length - rejected.length;
  const highNeeded = approved.some((a) => a.risk === 'high');
  const medNeeded = approved.some((a) => a.risk === 'medium');

  const v = validateApproval({
    actionIds: ids,
    approvals: approvalMap(),
    ticket: S.ticket,
    approver: S.approver,
  });
  const approvalReady = approved.length > 0 && v.ok;
  const noApprovalMessage = pending > 0
    ? 'No actions approved. Pending actions remain excluded from execution.'
    : 'No actions approved. The execution package contains no executable actions.';

  $('#approval-global').innerHTML = `
    <div class="rows" style="margin-bottom:9px">
      <div>Approval status: <b>Approved ${approved.length}</b> ｜ Rejected ${rejected.length} ｜ Pending ${pending}</div>
      ${plan.highestRisk ? `<div>Highest risk: <b>${RISK_LEVELS[plan.highestRisk].label}</b> ${RISK_LEVELS[plan.highestRisk].approval_detail}</div>` : ''}
    </div>
    ${highNeeded ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:560px;margin-bottom:6px">
        <div><div class="hint" style="margin-bottom:4px">Change-ticket number (required for high risk)</div>
          <input type="text" id="ticket-input" value="${esc(S.ticket)}" placeholder="e.g. CHG-2026-1014-01"></div>
        <div><div class="hint" style="margin-bottom:4px">Approver (required for high risk)</div>
          <input type="text" id="approver-input" value="${esc(S.approver)}" placeholder="e.g. litao"></div>
      </div>` : ''}
    ${medNeeded && !v.ok ? `<div class="hint" style="color:var(--mid)">Medium-risk actions require impact acknowledgement before inclusion in the execution package.</div>` : ''}
    ${approved.length === 0 ? `<div class="hint">${noApprovalMessage}</div>` : ''}
    ${approvalReady ? '<div class="hint" style="color:var(--ok)">Approval requirements met. The execution package is ready to export.</div>' : ''}
    ${!v.ok && v.blocking.length ? `<div class="hint" style="color:var(--warn)">${esc(v.blocking.join('; '))}</div>` : ''}`;

  const ti = $('#ticket-input');
  if (ti) ti.addEventListener('input', () => { S.ticket = ti.value; });
  const ai = $('#approver-input');
  if (ai) ai.addEventListener('input', () => { S.approver = ai.value; });

  $('#pkg-hint').textContent = approvalReady
    ? 'Approval requirements met'
    : approved.length === 0
      ? 'No actions approved; pending and rejected actions remain non-executable.'
      : 'Download available; unapproved actions are marked "Not approved; do not execute."';
}

/* Map UI approval state to action_id for validation. */
function approvalMap() {
  const map = {};
  for (const a of S.result?.actions || []) {
    const st = S.approvals[a.id];
    if (st && a.action_id) map[a.action_id] = st;
  }
  return map;
}

function exportPackage() {
  const out = S.result;
  if (!out) return;
  const c = S.current || {};
  const v = extractVerdict(out);

  const md = buildExecPackage({
    evidence: normalizeEvidence(c),
    conclusion: v
      ? {
          classification: v.class,
          classification_label: v.class_label,
          should_rma: v.should_rma,
          confidence: v.confidence,
          summary: (out.text || '').slice(0, 1200),
        }
      : { classification: 'undetermined', summary: (out.text || '').slice(0, 1200) },
    citations: out.citations || [],
    actionIds: (out.actions || []).map((a) => a.action_id).filter(Boolean),
    approvals: approvalMap(),
    ticket: S.ticket,
    approver: S.approver,
    model: out.model || '',
    mode: out.mode || '',
  });

  download(`triage-${c.id || 'case'}-${new Date().toISOString().slice(0, 10)}.md`, md);
  setStatus('#case-status', 'Execution package downloaded');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ======================================================================
// On-call patrol
// ======================================================================
/* Inline SVG icons with no CDN dependency. */
const ICO = {
  nodes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21 19H3z"/><path d="M12 10v4M12 16.5h.01"/></svg>',
  cordon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M6.5 17.5 17.5 6.5"/></svg>',
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
};

/* Calculate KPIs from the latest nodes. Use nodeSignals for both alerts and node cards. */
function renderClusterKpis(nodes) {
  const box = $('#cluster-kpis');
  if (!box) return;
  const n = nodes.length || 1;
  const alerts = nodes.filter((x) => nodeSignals(x).length);
  const slots = nodes.reduce((s, x) => s + (Number(x.gpu_count) || 0), 0);
  const cordoned = nodes.filter((x) => x.cordoned);
  const byType = {};
  for (const x of nodes) byType[x.gpu_type || 'Unknown'] = (byType[x.gpu_type || 'Unknown'] || 0) + 1;

  const bar = (parts) =>
    `<div class="sbar">${parts
      .map(([w, c]) => `<i style="width:${Number(w).toFixed(2)}%;background:${c}"></i>`)
      .join('')}</div>`;
  const chips = (names, cls) =>
    `<div class="schips">${names.map((t) => `<span class="schip ${cls}">${esc(t)}</span>`).join('')}</div>`;
  const card = (icon, label, value, unit, sub, extra = '') =>
    `<div class="kpi"><div class="kh"><span class="ic">${icon}</span>` +
    `<span class="k">${label}</span></div>` +
    `<div class="kv">${value}<span class="u">${unit}</span></div>` +
    `<div class="ks">${sub}</div>${extra}</div>`;

  box.innerHTML =
    card(ICO.nodes, 'Cluster nodes', n, 'nodes',
      `Total GPU slots ${slots} · ${esc(Object.entries(byType).map(([k, v]) => `${k} ×${v}`).join(' · '))}`,
      bar([[(n - alerts.length) * 100 / n, 'var(--ok)'], [alerts.length * 100 / n, 'var(--bad)']])) +
    card(ICO.alert, 'Flagged nodes', alerts.length, 'nodes',
      'Flags: Xid, ECC, smi, or blocked processes',
      alerts.length ? chips(alerts.map((x) => x.node), 'bad')
        : '<div class="schips"><span class="schip ok">No flags</span></div>') +
    card(ICO.cordon, 'Cordoned', cordoned.length, 'nodes',
      cordoned.length ? 'New tasks blocked; awaiting operator review' : 'No cordoned nodes',
      cordoned.length ? chips(cordoned.map((x) => x.node), 'warn') : '') +
    card(ICO.chip, 'GPU slots', slots, 'GPUs',
      `Read at ${esc(new Date().toLocaleTimeString('en-US', { hour12: false }))} · ${nodes.length} cluster documents`);
}

async function refreshCluster({ canRender = () => true } = {}) {
  const box = $('#nodes');
  try {
    if (!canRender()) return false;
    const nodes = await clusterApi.listNodes();
    if (!canRender()) return false;
    const alerts = nodes.filter((n) => nodeSignals(n).length).length;
    $('#cluster-meta').textContent =
      `${nodes.length} nodes; ${alerts} flagged · Live read from Cloud Firestore`;
    renderClusterKpis(nodes);
    box.innerHTML = nodes.map(nodeCard).join('');
    await Promise.all([renderEvents(canRender), renderTickets(canRender), renderNotifications(canRender)]);
    return canRender();
  } catch (err) {
    if (!canRender()) return false;
    box.innerHTML = `<div class="hint" style="color:var(--warn)">Cluster read failed: ${esc(err.message)}</div>`;
    const k = $('#cluster-kpis');
    if (k) k.innerHTML = '';
    return false;
  }
}

function nodeCard(n) {
  const sigs = nodeSignals(n);
  const cls = !sigs.length ? 'ok' : n.status === 'hang' || n.status === 'degraded' ? 'crit' : 'alert';
  const jobs = (n.jobs || []).map((j) => `${j.id}(${j.user})`);
  // The job class gives optional job rows stable grid placement.
  return `
  <div class="node ${cls}">
    <div class="n">${esc(n.node)}</div>
    <div class="s">${esc(n.gpu_type || '')} · ${esc(n.status)}${n.cordoned ? ' · Cordoned' : ''}</div>
    ${jobs.length ? `<div class="s job">Jobs: ${esc(jobs.join(', '))}</div>` : ''}
    ${sigs.length ? `<div class="sig">${sigs.map((s) => esc(s)).join('<br>')}</div>` : '<div class="cordon">No flagged signals</div>'}
  </div>`;
}

async function runPatrol() {
  const btn = $('#run-patrol');
  btn.disabled = true;
  $('#tab-patrol').dataset.state = 'running';

  // Refresh during patrol to show persisted actions as they complete.
  let ticking = false;
  let periodicActive = true;
  const tick = setInterval(() => {
    if (ticking) return; // Skip overlapping refresh requests.
    ticking = true;
    Promise.resolve()
      .then(() => refreshCluster({ canRender: () => periodicActive }))
      .catch(() => { /* Refresh failures do not interrupt patrol; the next tick retries. */ })
      .finally(() => {
        ticking = false;
      });
  }, 2500);

  try {
    setStatus('#patrol-status', 'Reading cluster…');
    $('#patrol-tools').innerHTML = '<li><span>Patrol running…</span></li>';
    $('#patrol-toolcount').textContent = '';
    await refreshCluster();

    const nodes = await clusterApi.listNodes();
    setStatus('#patrol-status', 'Patrol running; scanning and applying permitted actions…');

    const out = await patrol({
      cluster: clusterApi,
      clusterMeta: { node_count: nodes.length },
      onProgress: (msg) => setStatus('#patrol-status', msg),
    });

    S.patrol = out;
    $('#patrol-text').textContent = out.text || '';
    const trace = toolTraceHtml(out);
    $('#patrol-toolcount').textContent = toolCountText(trace.calls);
    $('#patrol-tools').innerHTML = trace.html;
    $('#patrol-mode').textContent = out.mode === 'gemini'
      ? `Executed by ${out.model}${out.resumed ? ' (resumed after upstream failure)' : ''}`
      : '(offline rule baseline; no model used)';
    $('#patrol-report-sec').style.display = 'block';

    // Expose failed action verification in the patrol status.
    if ((out.executions || []).some((e) => e.event && !e.event.verified)) {
      setStatus('#patrol-status', 'Complete; an action failed verification. See operation log.');
    } else {
      setStatus('#patrol-status', `Complete: ${(out.executions || []).length} actions, `
        + `${(out.tickets || []).length} tickets, ${(out.notifications || []).length} notifications`);
    }
  } catch (err) {
    setStatus('#patrol-status', `Failed: ${err.message}`);
    $('#tab-patrol').dataset.state = 'failed';
  } finally {
    periodicActive = false;
    clearInterval(tick);
    const refreshed = await refreshCluster();
    if ($('#tab-patrol').dataset.state === 'running') {
      $('#tab-patrol').dataset.state = refreshed ? 'complete' : 'failed';
    }
    btn.disabled = false;
  }
}

async function renderEvents(canRender = () => true) {
  const docs = await clusterApi.listDocs('events');
  if (!canRender()) return;
  docs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  $('#events-count').textContent = docs.length ? `${docs.length} entries` : '';
  $('#events').innerHTML = docs.length
    ? docs
        .map((e) => {
          const cls = e.status === 'ok' ? 'ok' : e.status === 'unverified' || e.status === 'error' ? 'fail' : 'info';
          const mark = e.status === 'ok' ? 'Verified' : e.status === 'unverified' ? 'Verification failed' : e.status === 'error' ? 'Execution error' : e.status;
          return `<li class="${cls}">
            <div class="tm">${esc(clock(e.at))} ${esc(e.node)} ${esc(e.risk)} ${esc(mark)}</div>
            <div class="tx">${esc(e.describe || e.action_label || e.action_id)}</div>
            ${e.reason ? `<div class="hint">Reason: ${esc(e.reason)}</div>` : ''}
            ${e.error ? `<div class="hint" style="color:var(--warn)">${esc(e.error)}</div>` : ''}
          </li>`;
        })
        .join('')
    : '<li><span class="tx">No operations recorded</span></li>';
}

async function renderTickets(canRender = () => true) {
  const docs = await clusterApi.listDocs('tickets');
  if (!canRender()) return;
  docs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  $('#tickets-count').textContent = docs.length ? `${docs.length} tickets` : '';
  $('#tickets').innerHTML = docs.length
    ? docs
        .map(
          (t) => `<div class="tk">
        <div class="h"><span class="badge ${t.approved ? 'low' : 'high'}">${t.approved ? 'Submitted' : 'Draft · Awaiting human submission'}</span>
          <span class="strong">${esc(t.title)}</span>
          <span class="chip">${esc(t.node)}</span>
          ${t.action_id ? `<span class="chip">${esc(t.action_id)}</span>` : ''}</div>
        <div class="b">${esc(String(t.body || '').slice(0, 420))}</div>
        ${(t.evidence_refs || []).length ? `<div style="margin-top:6px">${t.evidence_refs.map((r) => `<span class="chip ref">${esc(r)}</span>`).join('')}</div>` : ''}
        <div style="margin-top:8px" class="hint">A human must submit the ticket. RMA removes hardware capacity.</div>
      </div>`,
        )
        .join('')
    : '<div class="hint">No pending approvals</div>';
}

async function renderNotifications(canRender = () => true) {
  const docs = await clusterApi.listDocs('notifications');
  if (!canRender()) return;
  docs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  $('#notif-count').textContent = docs.length ? `${docs.length} queued` : '';
  $('#notifications').innerHTML = docs.length
    ? docs
        .map(
          (n) => `<div class="tk">
        <div class="h"><span class="badge ${n.severity === 'critical' ? 'high' : n.severity === 'warning' ? 'medium' : 'info'}">${esc(n.severity || 'info')}</span>
          <span class="strong">${esc(n.title)}</span><span class="chip">${esc(n.node)}</span>
          <span class="chip">${esc(n.status || 'queued')}</span></div>
        <div class="b">${esc(n.text)}</div>
      </div>`,
        )
        .join('')
    : '<div class="hint">No notifications</div>';
}

async function resetCluster() {
  const btn = $('#reset-cluster');
  btn.disabled = true;
  $('#cluster-status').dataset.state = 'running';
  try {
    setStatus('#patrol-status', 'Resetting simulated cluster…');
    const n = await clusterApi.resetCluster();
    setStatus('#patrol-status', `Reset ${n} nodes; operation logs and tickets cleared`);
    const refreshed = await refreshCluster();
    $('#cluster-status').dataset.state = refreshed ? 'reset' : 'failed';
  } catch (err) {
    setStatus('#patrol-status', `Reset failed: ${err.message}`);
    $('#cluster-status').dataset.state = 'failed';
  } finally {
    btn.disabled = false;
  }
}

// ======================================================================
// Benchmark
// ======================================================================
function runBenchRule() {
  const rows = S.cases.map((c) => {
    const ev = normalizeEvidence(c);
    const pre = preAnalyze(ev);
    const r = ruleBasedTriage(ev, pre);
    const cmp = compareWithExpected(r, c.expected);
    return { c, pre, r, cmp };
  });
  S.benchRule = rows;
  const pass = rows.filter((r) => r.cmp.pass).length;
  $('#bench-rule').textContent = `${pass} / ${S.cases.length}`;
  $('#bench-rule-sub').textContent = `Local run; no model quota used · Correct classifications ${rows.filter((r) => r.cmp.class_ok).length} / ${S.cases.length}`;
  setStatus('#bench-status', 'Rule baseline complete (local browser calculation)');
  renderBenchTable();
}

function renderBenchTable() {
  const rows = S.benchRule || [];
  const aiN = Object.keys(S.benchAi).length;
  if (aiN) {
    const aiPass = Object.values(S.benchAi).filter((v) => v.pass).length;
    $('#bench-ai').textContent = `${aiPass} / ${aiN}`;
    $('#bench-ai-sub').textContent = aiN < S.cases.length
      ? `${aiN} / ${S.cases.length} cases completed (includes case triage runs)`
      : 'All cases completed';
  }

  if (!rows.length) {
    $('#bench-tbl').innerHTML = '<tbody><tr><td class="hint">Select Run rule baseline to begin</td></tr></tbody>';
    return;
  }

  const head = ['Case', 'Expected class', 'Expected repair', 'Rule decision', 'Rule result', 'AI decision', 'AI result'];
  const body = rows
    .map((r) => {
      const ai = S.benchAi[r.c.id];
      return `<tr class="${r.cmp.pass ? '' : 'miss'}">
        <td class="mono">${esc(r.c.id)}</td>
        <td>${esc(r.c.expected.class)}</td>
        <td>${r.c.expected.should_rma ? 'Yes' : 'No'}</td>
        <td>${esc(r.r.class)} · ${r.r.should_rma ? 'Repair' : 'No repair'}</td>
        <td>${r.cmp.pass ? 'Pass' : '<b style="color:var(--warn)">Fail</b>'}</td>
        <td>${ai ? esc(ai.class) + ' · ' + (ai.should_rma ? 'Repair' : 'No repair') : '<span class="hint">Not run</span>'}</td>
        <td>${ai ? (ai.pass ? 'Pass' : '<b style="color:var(--warn)">Fail</b>') : '<span class="hint">-</span>'}</td>
      </tr>`;
    })
    .join('');
  $('#bench-tbl').innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

/* Run AI cases sequentially after quota confirmation; report progress. */
async function runBenchAi() {
  const todo = S.cases.filter((c) => !S.benchAi[c.id]);
  if (!todo.length) {
    setStatus('#bench-status', 'All cases have AI results.');
    return;
  }
  const ok = window.confirm(
    `Run the model sequentially for ${todo.length} cases.\n\n` +
      `Each case may make multiple model requests for tool calls. Free-tier quota is limited.\n` +
      `Results are cached locally for reuse.\n\nContinue?`,
  );
  if (!ok) return;

  const btn = $('#run-bench-ai');
  btn.disabled = true;
  let done = 0;
  for (const c of todo) {
    setStatus('#bench-status', `Running ${++done} / ${todo.length}: ${c.id}`);
    try {
      const out = await diagnose({ caseObj: c });
      noteAiVerdict(c, out);
      S.cache[c.id] = out;
    } catch (err) {
      setStatus('#bench-status', `${c.id} Failed: ${err.message} (continuing)`);
    }
    saveCache();
    renderBenchTable();
  }
  setStatus('#bench-status', `AI benchmark complete: ${Object.keys(S.benchAi).length} cases.`);
  btn.disabled = false;
}

// ======================================================================
// Action library and approvals
// ======================================================================
function renderActionsTab() {
  $('#risk-levels').innerHTML = RISK_ORDER.map((lv) => {
    const L = RISK_LEVELS[lv];
    const count = ACTION_LIST.filter((a) => a.risk === lv).length;
    return `<div class="ev" style="border-left:3px solid var(--${lv})">
      <div class="k">${esc(L.label)} ${count} actions</div>
      <div class="v">${esc(L.rule)}</div>
      <div class="hint" style="margin-top:6px">Approval: ${esc(L.approval)}</div>
      <div class="hint">${esc(L.approval_detail)}</div>
    </div>`;
  }).join('');

  $('#action-count').textContent = `${ACTION_LIST.length} actions`;
  const head = ['Action', 'Risk', 'Impact', 'Command', 'Expected output', 'Rollback'];
  // Keep command-column widths and wrapping in the stylesheet.
  $('#action-tbl').innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    ACTION_LIST.map(
      (a) => `<tr>
      <td><div class="strong">${esc(a.label)}</div><div class="hint mono">${esc(a.id)}</div></td>
      <td><span class="badge ${a.risk}">${esc(RISK_LEVELS[a.risk].label)}</span></td>
      <td class="hint">${esc(a.affects)}</td>
      <td class="mono cmd">${esc(a.cmds.join('\n'))}</td>
      <td class="hint">${esc(a.expect)}</td>
      <td class="hint">${esc(a.rollback)}</td>
    </tr>`,
    ).join('') +
    '</tbody>';

  $('#discouraged').innerHTML = Object.values(DISCOURAGED_ACTIONS)
    .map(
      (d) => `<div class="act muted">
      <div class="hd"><span class="badge info">Discouraged</span><span class="t">${esc(d.label)}</span>
        <span class="hint mono">${esc(d.id)}</span></div>
      <div class="d">${esc(d.reason)}</div>
      <div class="rows"><div>Instead: <b>${esc(d.instead)}</b></div></div>
      <div class="hint">This action is excluded from model candidates and is not selectable.
      </div>
    </div>`,
    )
    .join('');

  $('#boundaries').innerHTML = `
    <b>1. Simulated cluster only.</b>Cases are synthetic; patrol nodes are simulated.
    Production Tencent Cloud / Alibaba Cloud / Baidu Cloud / Zhixing Cloud clusters have no network connection to Google Cloud.
    Actions update persistent state in the simulated cluster.
    This demonstrates a <b>verified action loop</b>.
    <br><br>
    <b>2. Anonymous demo access.</b>The browser has no sign-in flow.
    Production requires Auth-based rules. Demo access is limited to four collections; all other paths are denied.
    <br><br>
    <b>3. Queued notifications.</b>Production requires a messaging or email integration.
    The demo queues notifications for review.
    <br><br>
    <b>4. Manual patrol trigger.</b>This static site has no resident process.
    Production would require a scheduler such as Cloud Scheduler.
    <br><br>
    <b>5. Knowledge-base coverage: 24 Xid codes.</b>Unknown codes remain unknown.
    For missing entries, tools return "No record; do not infer."`;
}

// ======================================================================
// Startup
// ======================================================================
async function init() {
  initTabs();
  renderActionsTab();
  try {
    await loadCases();
  } catch (err) {
    setStatus('#case-status', `Failed to load cases: ${err.message}`);
    return;
  }

  $('#run-case').addEventListener('click', () => runCase());
  $('#case-select').addEventListener('change', () => runCase());
  $('#export-pkg').addEventListener('click', exportPackage);
  $('#run-patrol').addEventListener('click', runPatrol);
  $('#refresh-cluster').addEventListener('click', refreshCluster);
  $('#reset-cluster').addEventListener('click', resetCluster);
  $('#run-bench').addEventListener('click', runBenchRule);
  $('#run-bench-ai').addEventListener('click', runBenchAi);
  $('#clear-bench').addEventListener('click', () => {
    S.benchAi = {};
    S.cache = {};
    saveCache();
    $('#bench-ai').textContent = '- / -';
    renderBenchTable();
    setStatus('#bench-status', 'Local cache and AI benchmark results cleared');
  });

  // Calculate the local rule baseline before the benchmark tab opens.
  runBenchRule();
  setStatus('#case-status', 'Select a case to begin (rule baseline ready)');
}

init();
