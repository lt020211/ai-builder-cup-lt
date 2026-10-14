/**
 * 界面装配层。
 *
 * 这一层做三件事，每件都对应一个必须让评委看见的东西：
 *   1. 单次分诊：把「代码算的」「模型判断的」「动作库定级的」三样东西**分开**呈现
 *   2. 值班巡检：把「Agent 真的动了什么手」用操作日志摊开，而不是只给一段总结
 *   3. 基准对照：把「为什么需要模型」变成一个可以自己点一遍验证的数字
 *
 * 一条贯穿全界面的原则：**不让任何东西看起来比它实际更可信**。
 *   · 遥测是快照还是实时，要标出来
 *   · 执行了但回验没通过，要显示为失败
 *   · 降级到规则路径时，要明说没有模型参与
 *   · 模拟集群与生产集群的区别，要写在页面上而不是只写在 README 里
 */

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
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso || '';
  }
};

// ======================================================================
// 状态
// ======================================================================
const S = {
  cases: [],
  current: null,
  result: null,
  pre: null,
  approvals: {},
  ticket: '',
  approver: '',
  /** AI 结果缓存：演示当天零等待、零配额消耗 */
  cache: loadCache(),
  /** 基准表里 AI 那一路的结果，按案例 id 累积 */
  benchAi: {},
};

/**
 * 缓存键里带版本号。
 *
 * ★ 为什么必须带：localStorage 里的东西是上一次**那版代码**产出的对象。
 *   代码改了字段（这次就发生了 —— 老结果里根本没有 tool_calls），
 *   缓存却照旧命中，于是界面用旧形状渲染新界面，你会看到一个
 *   早已修好的 bug 还在原地。**排查时最怕的就是证据本身是旧的。**
 *   改字段就升版本号，老条目自然失效，不用手动去清浏览器存储。
 */
const CACHE_KEY = 'triage:cache:v2';

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
    /* 无痕模式下写不进去，忽略即可——缓存只是加速，不是功能 */
  }
}

function setStatus(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

// ======================================================================
// 标签页
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
// 单次分诊
// ======================================================================
async function loadCases() {
  const res = await fetch('./data/cases.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`案例库加载失败 HTTP ${res.status}`);
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
  S.current = c;
  S.approvals = {};
  S.ticket = '';
  S.approver = '';

  const evidence = normalizeEvidence(c);
  S.pre = preAnalyze(evidence);

  // 先把确定性部分画出来：让人不用对着空屏等模型
  renderEvidence(evidence, S.pre);
  renderVerdictFromRule(evidence, S.pre);
  $('#case-result').style.display = 'block';
  $('#tools').innerHTML = '';
  $('#aitext').textContent = '';
  $('#degradereason').style.display = 'none';

  // 缓存命中就直接用：演示现场最怕的是当场等模型配额
  const hit = !ignoreCache && S.cache[c.id];
  if (hit) {
    S.result = hit;
    S.result.fromCache = true;
    renderAll(c, evidence);
    setStatus('#case-status', '已使用本地缓存结果（不消耗模型配额）');
    btn.disabled = false;
    return;
  }

  setStatus('#case-status', `本地预分析完成，正在等待 ${DEFAULT_MODEL}…`);
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
    setStatus('#case-status', out.mode === 'gemini' ? '完成' : '完成（已降级）');
  } catch (err) {
    setStatus('#case-status', `失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** 把 AI 结果里可结构化的部分记进基准表。分诊过的案例会自动积累成对照数据。 */
function noteAiVerdict(c, out) {
  const v = extractVerdict(out);
  const cmp = v && compareWithExpected({ class: v.class, should_rma: v.should_rma }, c.expected);
  if (cmp) S.benchAi[c.id] = { ...v, ...cmp };
}

/** ★ 结论只从模型登记的结构化建议里取，不从它的散文里猜。 */
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
  $('#verdict-mode').textContent = '（规则预判，模型结论稍后覆盖）';
  $('#verdict').className = `verdict ${r.should_rma ? 'rma' : 'norma'}`;
  $('#verdict').innerHTML = `
    <div class="big">
      <div class="lbl">是否报修</div>
      <div class="val">${r.should_rma ? '建议报修' : '不建议报修'}</div>
      <div class="lbl" style="margin-top:8px">规则路径 · 置信度 ${pct(r.confidence)}</div>
    </div>
    <div class="meta">
      <div class="row"><span class="k">故障分类</span><span>${esc(r.class)}</span></div>
      <div class="row"><span class="k">规则依据</span><span class="hint">${esc(r.basis.join('；') || '（无匹配证据）')}</span></div>
      <div class="row"><span class="k">口径</span><span class="hint">${esc(r.note)}</span></div>
      ${expected ? `<div class="row"><span class="k">案例期望</span><span class="hint">${esc(expected.class)} · ${expected.should_rma ? '需报修' : '不需报修'}</span></div>` : ''}
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
  // ★ 这句话必须由**实际发生的调用次数**决定，不能按 mode 直接断言。
  //   原先写死成「由 <model> 自主调用工具生成」——只要拿到了模型响应就这么说，
  //   哪怕它一次工具都没调。于是会出现同一屏上「自主调用工具生成」与
  //   「本次没有调用工具」并存的情况。宁可说得朴素，也不能说得比实际更硬。
  const nCalls = (out.tool_calls || []).length;
  const modeNote = {
    gemini: nCalls
      ? `由 ${out.model} 自主调用工具生成（${nCalls} 次调用）`
      : `由 ${out.model} 直接作答，本次未调用工具`,
    fallback: '模型调用失败，已降级为离线规则模板',
    offline: '离线规则模板，未调用大模型',
  }[out.mode] || out.mode;
  const degraded = (out.degraded || []).length
    ? `　← 已从 ${out.degraded.map((d) => d.model).join('、')} 降级`
    : '';
  $('#verdict-mode').textContent = `（${modeNote}${degraded}）${out.fromCache ? '　· 本地缓存' : ''}`;

  if (out.degraded?.length) {
    $('#degradereason').style.display = 'block';
    // 措辞刻意用「模型失败原因」而不是「换模型原因」：
    // 全部模型都失败时并没有换成谁，写「换模型」会误导。
    $('#degradereason').innerHTML =
      '模型失败原因：' + out.degraded.map((d) => `<b>${esc(d.model)}</b> — ${esc(d.reason)}`).join('　｜　');
  }

  if (!v) {
    // 模型没有登记结构化建议——如实说明，不替它编一个结论
    $('#verdict').className = 'verdict';
    $('#verdict').innerHTML = `
      <div class="big"><div class="lbl">是否报修</div><div class="val">未登记</div></div>
      <div class="meta">
        <div class="row"><span class="k">说明</span>
          <span class="hint">模型本次没有通过 <code>propose_fix</code> 登记结构化结论，
          因此没有可核对的分类与报修判断。上方规则预判可作参考，但它不读趋势、不辨因果链。
          这种情况本身也是一个信号：<b>证据可能不足以支撑一个明确结论。</b></span></div>
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
      <div class="lbl">是否报修</div>
      <div class="val">${v.should_rma ? '需要报修' : '不需要报修'}</div>
      <div class="lbl" style="margin-top:8px">模型置信度 ${pct(conf)}</div>
    </div>
    <div class="meta">
      <div class="row"><span class="k">故障分类</span><span class="strong">${esc(v.class_label || v.class)}</span></div>
      <div class="row"><span class="k">置信度</span>
        <span><span class="confbar"><i style="width:${Math.round(conf * 100)}%"></i></span></span></div>
      ${expected ? `<div class="row"><span class="k">案例期望</span>
        <span>${esc(expected.class)} · ${expected.should_rma ? '需报修' : '不需报修'}
        ${agreeClass && agreeRma ? '<span class="chip" style="color:var(--ok);border-color:var(--ok)">与期望一致</span>'
          : '<span class="chip" style="color:var(--warn);border-color:var(--warn)">与期望不一致</span>'}</span></div>` : ''}
      <div class="row"><span class="k">为什么值钱</span>
        <span class="hint">${esc(expected?.trap || '——')}</span></div>
    </div>`;
}

function renderEvidence(evidence, pre) {
  const c = pre.confirmed;
  const tel = evidence.node_telemetry || {};
  const items = [];

  items.push(['报错原文', `<pre class="cmd" style="margin:0">${esc(String(evidence.stderr_excerpt || '（无）').slice(0, 900))}</pre>`, '']);

  const env = evidence.environment || {};
  items.push([
    '环境版本栈',
    Object.entries(env).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('<br>') || '（未提供）',
    c.compat_ok === false ? 'bad' : 'good',
  ]);

  items.push([
    '检出的 Xid',
    c.xids.length
      ? c.xids.map((x) => `Xid ${x.code} ×${x.count}　${x.known ? esc(x.name) : '<b>知识库无记录</b>'}`).join('<br>')
      : '未检出',
    c.xids.some((x) => !x.known) ? 'bad' : '',
  ]);

  items.push(['匹配到的特征', c.signatures.length ? c.signatures.map((s) => esc(s.label)).join('<br>') : '未匹配', '']);

  if (c.memory_fit) {
    items.push([
      '显存核算',
      `${c.memory_required_gb} GB / 容量 ${c.memory_capacity_gb} GB<br>判定 <b>${esc(c.memory_fit)}</b>`,
      c.memory_fit === 'will_oom' ? 'bad' : 'good',
    ]);
  }

  items.push(['版本自检', c.compat_ok ? '版本组合自洽' : esc((c.compat_issues || []).join('；')), c.compat_ok ? 'good' : 'bad']);

  const evt = (tel.xid_events || []);
  if (evt.length) {
    items.push([
      '节点遥测 · Xid 事件',
      evt.map((e) => `Xid ${e.code}${e.gpu !== undefined ? ` · GPU ${e.gpu}` : ''}${e.at ? ` · ${esc(e.at)}` : ''}${e.count ? ` ×${e.count}` : ''}`).join('<br>'),
      '',
    ]);
  }
  if (tel.history_30d) {
    items.push([
      '节点遥测 · 30 天趋势',
      `Xid 94 累计 <b>${tel.history_30d.xid94_count}</b> 次<br>可纠正 ECC 趋势 <b>${esc(tel.history_30d.ecc_correctable_trend)}</b>`,
      tel.history_30d.ecc_correctable_trend === 'rising' ? 'bad' : '',
    ]);
  }
  if (tel.ecc_uncorrectable !== undefined) {
    items.push(['ECC', `不可纠正 ${tel.ecc_uncorrectable}　可纠正 ${tel.ecc_correctable}`, tel.ecc_uncorrectable > 0 ? 'bad' : '']);
  }

  $('#evidence').innerHTML = `<div class="grid">${items
    .map(([k, v, cls]) => `<div class="ev"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`)
    .join('')}</div>`;

  $('#verdict-mode').dataset.evidenceReady = '1';
}

/**
 * 工具轨迹的 HTML。**单次分诊与值班巡检共用同一份渲染**。
 *
 * 抽出来是因为值班页原本没有这一栏 —— 于是「证据链」这个卖点在值班模式下
 * 根本看不见，而值班恰恰是最需要让人信服它「不是随便给个结论」的地方。
 */
function toolTraceHtml(out) {
  const calls = out.tool_calls || [];
  const refs = (out.citations || [])
    .map((c) => `${c.ref} = ${c.source}`)
    .join('　');
  let html;
  if (calls.length) {
    html = calls
      .map((c) => `<li><b>${esc(c.name)}</b><span>${esc(JSON.stringify(c.args))}</span></li>`)
      .join('') + (refs ? `<li><b>引用表</b><span>${esc(refs)}</span></li>` : '');
  } else if (out.pipeline_error || refs) {
    // ★ 有引用就说明工具跑过；有 pipeline_error 就是打包链路自报的问题。
    //   两种情况都**必须显式报出来**，不能默默显示成「本次没有调用工具」——
    //   那会把一个 bug 伪装成一次正常行为（这个坑真的踩过）。
    html = `<li class="fail"><b>链路异常</b><span>`
      + esc(out.pipeline_error || `本次存在 ${(out.citations || []).length} 条工具引用（${refs}），但没有调用记录。`)
      + `</span></li>`;
  } else {
    html = '<li><span>本次没有调用工具：结论来自离线规则或模型直接输出。</span></li>';
  }
  if (out.error) html += `<li><b>错误</b><span>${esc(out.error)}</span></li>`;
  return { calls, html };
}

function toolCountText(calls) {
  return calls.length ? `共 ${calls.length} 次调用` : '（无工具调用）';
}

function renderTools(out) {
  const { calls, html } = toolTraceHtml(out);
  $('#toolcount').textContent = toolCountText(calls);
  $('#tools').innerHTML = html;
}

// ---------------------------------------------------------------- 处置与审批
function renderActions(out) {
  const actions = out.actions || [];
  const box = $('#actions');
  if (!actions.length) {
    box.innerHTML = '<div class="hint">本次没有登记任何处置建议。</div>';
    $('#approval-global').innerHTML = '';
    $('#acts-hint').textContent = '';
    return;
  }

  $('#acts-hint').textContent = `${actions.length} 条，按风险从低到高排列`;

  // 按风险分组渲染：不同风险级的审批要求不同，混在一起会把要求稀释掉
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
      ${a.should_rma === true ? '<span class="badge high">建议报修</span>' : ''}
      ${a.should_rma === false ? '<span class="badge info">不建议报修</span>' : ''}
      <span class="chip">置信度 ${pct(a.confidence)}</span>
    </div>
    <div class="d">${esc(a.detail || '')}</div>
    <div class="rows">
      <div>影响面：<b>${esc(a.affects || '—')}</b></div>
      <div>审批要求：<b>${esc(a.approval_requirement || RISK_LEVELS[a.risk]?.approval || '—')}</b></div>
      ${a.cmds?.length ? `<div>命令：<code>${esc(a.cmds[0])}</code>${a.cmds.length > 1 ? ` <span class="hint">（共 ${a.cmds.length} 行，见执行包）</span>` : ''}</div>` : ''}
      ${a.rollback ? `<div>回滚：<b>${esc(a.rollback)}</b></div>` : '<div style="color:var(--warn)">★ 缺回滚方案，不允许进执行包</div>'}
      ${a.note ? `<div class="hint">${esc(a.note)}</div>` : ''}
      ${a.evidence ? `<div class="hint">依据：${esc(a.evidence)}</div>` : ''}
    </div>
    <div class="acts-actions">
      ${isPending ? `<button class="mini accept" data-act="approve" data-id="${esc(a.id)}">批准</button>
                     <button class="mini reject" data-act="reject" data-id="${esc(a.id)}">拒绝</button>`
        : `<span class="chip">${st.decision === 'approve' ? '已批准' : '已拒绝'} · ${esc(clock(st.decidedAt))}</span>
           <button class="mini ghost" data-act="reset" data-id="${esc(a.id)}">撤销</button>`}
      ${needAck ? `<label class="chk"><input type="checkbox" data-ack="${esc(a.id)}" ${st.impact_ack ? 'checked' : ''}>
        我已确认该节点上的其他任务会被影响</label>` : ''}
    </div>
  </div>`;
}

function renderApprovalBar() {
  const actions = S.result?.actions || [];
  const ids = actions.map((a) => a.action_id).filter(Boolean);
  const plan = buildApprovalPlan(ids);
  const approved = actions.filter((a) => S.approvals[a.id]?.decision === 'approve');
  const rejected = actions.filter((a) => S.approvals[a.id]?.decision === 'reject');
  const highNeeded = approved.some((a) => a.risk === 'high');
  const medNeeded = approved.some((a) => a.risk === 'medium');

  const v = validateApproval({
    actionIds: ids,
    approvals: approvalMap(),
    ticket: S.ticket,
    approver: S.approver,
  });

  $('#approval-global').innerHTML = `
    <div class="rows" style="margin-bottom:9px">
      <div>审批进度：<b>已批准 ${approved.length}</b> ｜ 已拒绝 ${rejected.length} ｜ 待决 ${actions.length - approved.length - rejected.length}</div>
      ${plan.highestRisk ? `<div>本次最高风险：<b>${RISK_LEVELS[plan.highestRisk].label}</b>　${RISK_LEVELS[plan.highestRisk].approval_detail}</div>` : ''}
    </div>
    ${highNeeded ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:560px;margin-bottom:6px">
        <div><div class="hint" style="margin-bottom:4px">变更单号（高风险必填）</div>
          <input type="text" id="ticket-input" value="${esc(S.ticket)}" placeholder="如 CHG-2026-1014-01"></div>
        <div><div class="hint" style="margin-bottom:4px">审批人（高风险必填）</div>
          <input type="text" id="approver-input" value="${esc(S.approver)}" placeholder="如 litao"></div>
      </div>` : ''}
    ${medNeeded && !v.ok ? `<div class="hint" style="color:var(--mid)">中风险动作需要勾选影响面确认后才能进执行包。</div>` : ''}
    ${v.ok ? '<div class="hint" style="color:var(--ok)">审批要件已齐备，可以导出执行包。</div>' : ''}
    ${!v.ok && v.blocking.length ? `<div class="hint" style="color:var(--warn)">${esc(v.blocking.join('；'))}</div>` : ''}`;

  const ti = $('#ticket-input');
  if (ti) ti.addEventListener('input', () => { S.ticket = ti.value; });
  const ai = $('#approver-input');
  if (ai) ai.addEventListener('input', () => { S.approver = ai.value; });

  $('#pkg-hint').textContent = v.ok
    ? '审批要件齐备'
    : '仍可下载：未获批准的动作会在执行包里标注「未批准，请勿执行」';
}

/** 把界面上的审批状态映射成 action_id → 状态，供 validateApproval 使用。 */
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
  setStatus('#case-status', '执行包已下载');
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
// 值班巡检
// ======================================================================
/** 概览卡里用的小图标（内联 SVG，不引任何 CDN）。 */
const ICO = {
  nodes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21 19H3z"/><path d="M12 10v4M12 16.5h.01"/></svg>',
  cordon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M6.5 17.5 17.5 6.5"/></svg>',
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
};

/**
 * 集群概览条。
 *
 * ★ 每一个数字都从**这次实际读到的节点**算出来，没有一个写死的常量。
 *   原因很直接：巡检会真的 cordon 节点、重置会真的改回来，
 *   概览里的「已 cordon」必须跟着动 —— 写死的话，它就成了界面在撒谎。
 *   「异常节点」用 nodeSignals() 判定，和节点卡片上显示的信号是**同一个函数**，
 *   不会出现「卡片有信号但概览说没有」这种自相矛盾。
 */
function renderClusterKpis(nodes) {
  const box = $('#cluster-kpis');
  if (!box) return;
  const n = nodes.length || 1;
  const alerts = nodes.filter((x) => nodeSignals(x).length);
  const slots = nodes.reduce((s, x) => s + (Number(x.gpu_count) || 0), 0);
  const cordoned = nodes.filter((x) => x.cordoned);
  const byType = {};
  for (const x of nodes) byType[x.gpu_type || '未知'] = (byType[x.gpu_type || '未知'] || 0) + 1;

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
    card(ICO.nodes, '集群节点', n, '台',
      `卡位合计 ${slots} · ${esc(Object.entries(byType).map(([k, v]) => `${k} ×${v}`).join(' · '))}`,
      bar([[(n - alerts.length) * 100 / n, 'var(--ok)'], [alerts.length * 100 / n, 'var(--bad)']])) +
    card(ICO.alert, '存在异常现象的节点', alerts.length, '个',
      '判据是 nodeSignals()：Xid / ECC / smi / 进程阻塞，任一非空即计入',
      alerts.length ? chips(alerts.map((x) => x.node), 'bad')
        : '<div class="schips"><span class="schip ok">全部无异常</span></div>') +
    card(ICO.cordon, '已 cordon', cordoned.length, '个',
      cordoned.length ? '禁止接新任务，等人工处置' : '当前没有节点被隔离',
      cordoned.length ? chips(cordoned.map((x) => x.node), 'warn') : '') +
    card(ICO.chip, '卡位', slots, '张',
      `读取于 ${esc(new Date().toLocaleTimeString('zh-CN', { hour12: false }))} · cluster 集合 ${nodes.length} 个文档`);
}

async function refreshCluster() {
  const box = $('#nodes');
  try {
    const nodes = await clusterApi.listNodes();
    const alerts = nodes.filter((n) => nodeSignals(n).length).length;
    $('#cluster-meta').textContent =
      `${nodes.length} 个节点，其中 ${alerts} 个存在异常现象　·　数据来自 Cloud Firestore（实时读取）`;
    renderClusterKpis(nodes);
    box.innerHTML = nodes.map(nodeCard).join('');
    await Promise.all([renderEvents(), renderTickets(), renderNotifications()]);
  } catch (err) {
    box.innerHTML = `<div class="hint" style="color:var(--warn)">集群读取失败：${esc(err.message)}</div>`;
    const k = $('#cluster-kpis');
    if (k) k.innerHTML = '';
  }
}

function nodeCard(n) {
  const sigs = nodeSignals(n);
  const cls = !sigs.length ? 'ok' : n.status === 'hang' || n.status === 'degraded' ? 'crit' : 'alert';
  const jobs = (n.jobs || []).map((j) => `${j.id}(${j.user})`);
  // ★ `.s.job` 那个 job 类名是给样式用的：D 版节点是「单栏横向整行」，
  //   三个信息块靠 grid 的显式列定位（名字 / 规格·状态 / 任务），
  //   两个 .s 长得一样，样式没法区分谁是谁。加一个类名比在样式里写
  //   :nth-child(3) 稳 —— 任务行是可选的，nth-child 会错位。
  return `
  <div class="node ${cls}">
    <div class="n">${esc(n.node)}</div>
    <div class="s">${esc(n.gpu_type || '')} · ${esc(n.status)}${n.cordoned ? ' · 已 cordon' : ''}</div>
    ${jobs.length ? `<div class="s job">任务：${esc(jobs.join('、'))}</div>` : ''}
    ${sigs.length ? `<div class="sig">${sigs.map((s) => esc(s)).join('<br>')}</div>` : '<div class="cordon">无异常信号</div>'}
  </div>`;
}

async function runPatrol() {
  const btn = $('#run-patrol');
  btn.disabled = true;

  // ★ 巡检期间定时刷新。
  //
  // 动作是**一步步真的落库**的（cordon 写完、工单写完、通知写完各是一次网络往返），
  // 所以这里让人看见它一条条落下来的过程，而不是等结束了再一次性刷出来 ——
  // 后者看完只会觉得「刷了一下」；前者能看出它真的在动。
  //
  // 顺带解决一个体验问题：巡检要跑 30–120 秒（取决于模型响应速度与上游是否抖动）。
  // 没有过程显示时，这一分多钟看起来就是「点了没反应」。
  let ticking = false;
  const tick = setInterval(() => {
    if (ticking) return; // 上一次还没回来就跳过，避免请求叠在一起
    ticking = true;
    Promise.resolve()
      .then(() => refreshCluster())
      .catch(() => { /* 刷新失败不打扰主流程，它会自己重试 */ })
      .finally(() => { ticking = false; });
  }, 2500);

  try {
    setStatus('#patrol-status', '读取集群…');
    $('#patrol-tools').innerHTML = '<li><span>巡检中…</span></li>';
    $('#patrol-toolcount').textContent = '';
    await refreshCluster();

    const nodes = await clusterApi.listNodes();
    setStatus('#patrol-status', '巡检中，模型将自行扫描并处置…');

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
      ? `由 ${out.model} 自主执行${out.resumed ? '（上游失败过一次，已带进度续跑）' : ''}`
      : '（离线规则路径，未调用模型）';
    $('#patrol-report-sec').style.display = 'block';

    // 报告里如果提到执行失败，界面上必须也看得见——不能只在日志里
    if ((out.executions || []).some((e) => e.event && !e.event.verified)) {
      setStatus('#patrol-status', '完成，但有一条动作回验未通过，见操作日志');
    } else {
      setStatus('#patrol-status', `完成：执行 ${(out.executions || []).length} 个动作，`
        + `建工单 ${(out.tickets || []).length} 张，通知 ${(out.notifications || []).length} 条`);
    }
  } catch (err) {
    setStatus('#patrol-status', `失败：${err.message}`);
  } finally {
    clearInterval(tick);
    await refreshCluster();
    btn.disabled = false;
  }
}

async function renderEvents() {
  const docs = await clusterApi.listDocs('events');
  docs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  $('#events-count').textContent = docs.length ? `${docs.length} 条` : '';
  $('#events').innerHTML = docs.length
    ? docs
        .map((e) => {
          const cls = e.status === 'ok' ? 'ok' : e.status === 'unverified' || e.status === 'error' ? 'fail' : 'info';
          const mark = e.status === 'ok' ? '回验通过' : e.status === 'unverified' ? '回验未通过' : e.status === 'error' ? '执行出错' : e.status;
          return `<li class="${cls}">
            <div class="tm">${esc(clock(e.at))}　${esc(e.node)}　${esc(e.risk)}　${esc(mark)}</div>
            <div class="tx">${esc(e.describe || e.action_label || e.action_id)}</div>
            ${e.reason ? `<div class="hint">理由：${esc(e.reason)}</div>` : ''}
            ${e.error ? `<div class="hint" style="color:var(--warn)">${esc(e.error)}</div>` : ''}
          </li>`;
        })
        .join('')
    : '<li><span class="tx">暂无操作记录</span></li>';
}

async function renderTickets() {
  const docs = await clusterApi.listDocs('tickets');
  docs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  $('#tickets-count').textContent = docs.length ? `${docs.length} 张` : '';
  $('#tickets').innerHTML = docs.length
    ? docs
        .map(
          (t) => `<div class="tk">
        <div class="h"><span class="badge ${t.approved ? 'low' : 'high'}">${t.approved ? '已提交' : '草稿 · 待人工提交'}</span>
          <span class="strong">${esc(t.title)}</span>
          <span class="chip">${esc(t.node)}</span>
          ${t.action_id ? `<span class="chip">${esc(t.action_id)}</span>` : ''}</div>
        <div class="b">${esc(String(t.body || '').slice(0, 420))}</div>
        ${(t.evidence_refs || []).length ? `<div style="margin-top:6px">${t.evidence_refs.map((r) => `<span class="chip ref">${esc(r)}</span>`).join('')}</div>` : ''}
        <div style="margin-top:8px" class="hint">提交这一步必须由人完成：报修不可逆，走一次 RMA 集群就少一块卡。</div>
      </div>`,
        )
        .join('')
    : '<div class="hint">暂无待批准事项</div>';
}

async function renderNotifications() {
  const docs = await clusterApi.listDocs('notifications');
  docs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  $('#notif-count').textContent = docs.length ? `${docs.length} 条 · 队列中` : '';
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
    : '<div class="hint">暂无通知</div>';
}

async function resetCluster() {
  const btn = $('#reset-cluster');
  btn.disabled = true;
  try {
    setStatus('#patrol-status', '正在重置模拟集群…');
    const n = await clusterApi.resetCluster();
    setStatus('#patrol-status', `已重置 ${n} 个节点，操作日志与工单已清空`);
    await refreshCluster();
  } catch (err) {
    setStatus('#patrol-status', `重置失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ======================================================================
// 基准对照
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
  $('#bench-rule-sub').textContent = `本地运行，未消耗任何模型配额 · 分类正确 ${rows.filter((r) => r.cmp.class_ok).length} / ${S.cases.length}`;
  setStatus('#bench-status', '规则基线已跑完（这一路完全在浏览器里算，可反复点）');
  renderBenchTable();
}

function renderBenchTable() {
  const rows = S.benchRule || [];
  const aiN = Object.keys(S.benchAi).length;
  if (aiN) {
    const aiPass = Object.values(S.benchAi).filter((v) => v.pass).length;
    $('#bench-ai').textContent = `${aiPass} / ${aiN}`;
    $('#bench-ai-sub').textContent = aiN < S.cases.length
      ? `已跑 ${aiN} / ${S.cases.length} 个案例（在「单次分诊」里跑过的会自动计入）`
      : '全部案例已跑完';
  }

  if (!rows.length) {
    $('#bench-tbl').innerHTML = '<tbody><tr><td class="hint">点击「跑规则基线」开始</td></tr></tbody>';
    return;
  }

  const head = ['案例', '期望分类', '期望报修', '规则给出', '规则结果', 'AI 给出', 'AI 结果'];
  const body = rows
    .map((r) => {
      const ai = S.benchAi[r.c.id];
      return `<tr class="${r.cmp.pass ? '' : 'miss'}">
        <td class="mono">${esc(r.c.id)}</td>
        <td>${esc(r.c.expected.class)}</td>
        <td>${r.c.expected.should_rma ? '是' : '否'}</td>
        <td>${esc(r.r.class)} · ${r.r.should_rma ? '报修' : '不报修'}</td>
        <td>${r.cmp.pass ? '对' : '<b style="color:var(--warn)">错</b>'}</td>
        <td>${ai ? esc(ai.class) + ' · ' + (ai.should_rma ? '报修' : '不报修') : '<span class="hint">未跑</span>'}</td>
        <td>${ai ? (ai.pass ? '对' : '<b style="color:var(--warn)">错</b>') : '<span class="hint">—</span>'}</td>
      </tr>`;
    })
    .join('');
  $('#bench-tbl').innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

/** 依次跑 AI：会真的消耗配额，所以先确认，并且逐个显示进度。 */
async function runBenchAi() {
  const todo = S.cases.filter((c) => !S.benchAi[c.id]);
  if (!todo.length) {
    setStatus('#bench-status', '全部案例都已经跑过 AI 了。');
    return;
  }
  const ok = window.confirm(
    `即将对 ${todo.length} 个案例逐个调用模型。\n\n` +
      `每个案例可能产生多次模型请求（多回合工具调用），免费层配额有限。\n` +
      `结果会缓存到本地，第二次运行不会重复消耗。\n\n继续吗？`,
  );
  if (!ok) return;

  const btn = $('#run-bench-ai');
  btn.disabled = true;
  let done = 0;
  for (const c of todo) {
    setStatus('#bench-status', `正在跑 ${++done} / ${todo.length}：${c.id}`);
    try {
      const out = await diagnose({ caseObj: c });
      noteAiVerdict(c, out);
      S.cache[c.id] = out;
    } catch (err) {
      setStatus('#bench-status', `${c.id} 失败：${err.message}（继续下一个）`);
    }
    saveCache();
    renderBenchTable();
  }
  setStatus('#bench-status', `AI 基准跑完，共 ${Object.keys(S.benchAi).length} 个案例。`);
  btn.disabled = false;
}

// ======================================================================
// 动作库与审批
// ======================================================================
function renderActionsTab() {
  $('#risk-levels').innerHTML = RISK_ORDER.map((lv) => {
    const L = RISK_LEVELS[lv];
    const count = ACTION_LIST.filter((a) => a.risk === lv).length;
    return `<div class="ev" style="border-left:3px solid var(--${lv})">
      <div class="k">${esc(L.label)}　${count} 条动作</div>
      <div class="v">${esc(L.rule)}</div>
      <div class="hint" style="margin-top:6px">审批：${esc(L.approval)}</div>
      <div class="hint">${esc(L.approval_detail)}</div>
    </div>`;
  }).join('');

  $('#action-count').textContent = `共 ${ACTION_LIST.length} 条`;
  const head = ['动作', '等级', '影响面', '命令', '预期输出', '回滚'];
  // ★ 命令列的宽度只能由样式表决定，不能写死在这里。
  //   这一格原来是 `<td class="mono" style="max-width:280px;…">`。那有两个问题：
  //     1) 内联样式优先级最高 —— 表格给它多少宽度都没用，这一列被永久卡在 280px，
  //        一条多行 shell 被断成每行三十来个字符；
  //     2) 它和样式表里 #action-tbl 的 table-layout:fixed 列宽定义打架，
  //        谁赢取决于写法，改动之后不看渲染结果根本不知道。
  //   换成 class 之后，宽度只有一个来源。换行方式（pre-wrap + break-all）
  //   挪进样式表，行为不变。
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
      <div class="hd"><span class="badge info">不建议</span><span class="t">${esc(d.label)}</span>
        <span class="hint mono">${esc(d.id)}</span></div>
      <div class="d">${esc(d.reason)}</div>
      <div class="rows"><div>应该改为：<b>${esc(d.instead)}</b></div></div>
      <div class="hint">这条动作保留在库里、但**不会出现在给模型的候选清单里**，界面上也灰显不可选。
      系统知道有这条路，但选择不推荐它 —— 这本身就是一种判断力。</div>
    </div>`,
    )
    .join('');

  $('#boundaries').innerHTML = `
    <b>1. 不接入任何真实生产集群。</b>分诊用的案例是构造的，值班用的节点是模拟的。
    真实的腾讯云 / 阿里云 / 百度云 / 智星云集群与 Google Cloud 之间没有网络通路，
    从架构上也够不着。演示里的「执行」作用在一个有真实状态的模拟集群上 ——
    它证明的是<b>闭环成立</b>，而不是「帮你运维生产集群」。
    <br><br>
    <b>2. 模拟集群的安全规则是匿名可读写。</b>因为浏览器端没有登录流程。
    生产部署必须换成基于 Auth 的规则；当前开放面被锁死在 4 个集合内，其余路径一律拒绝。
    <br><br>
    <b>3. 通知落到队列，不假装已经发出去。</b>真实部署时这里应接 IM / 邮件系统，
    演示环境下它是「待推送」状态，方便现场核对内容是否准确。
    <br><br>
    <b>4. 主动巡检由人点一下启动。</b>纯静态站点没有常驻进程 ——
    真实部署应由 Cloud Scheduler 之类定时触发。
    <br><br>
    <b>5. 覆盖 24 个 Xid 码，查不到就说查不到。</b>知识库边界就是模型的能力边界。
    遇到没有记录的码，工具返回「无记录，不得推测」，而不是让模型编一个解释。`;
}

// ======================================================================
// 启动
// ======================================================================
async function init() {
  initTabs();
  renderActionsTab();
  try {
    await loadCases();
  } catch (err) {
    setStatus('#case-status', `案例库加载失败：${err.message}`);
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
    $('#bench-ai').textContent = '— / —';
    renderBenchTable();
    setStatus('#bench-status', '已清空本地缓存与 AI 基准结果');
  });

  // 预热：把规则基线先跑好，切到「基准对照」时立刻能看到数字
  runBenchRule();
  setStatus('#case-status', '选一个案例开始（规则基线已在后台跑好）');
}

init();
