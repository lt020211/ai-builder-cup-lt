/* Gemini orchestration over Firebase AI Logic REST with platform-managed keys. Use user-role function responses; current models reject function-role responses, and the SDK blocks functionResponse in user content. Round-trip probes are in scripts/probe_tool_roundtrip.py. This static site currently sends no App Check token. Case and patrol share bounded tool loops, model fallback, and offline results. */

import { TOOL_SPECS, toolSpecsFor, ToolState, dispatchTool, nodeSignals } from './tools.js';
import { buildCasePrompt, buildPatrolPrompt } from './prompt.js';
import { normalizeEvidence, preAnalyze, ruleBasedTriage } from './triage.js';
import { ACTION_LIST, RISK_LEVELS, suggestActions, getAction } from './actions.js';
import { CLASSES } from './kb.js';

// ---------------------------------------------------------------- Firebase
/* Public Firebase web configuration. Security depends on rules and App Check. */
export const FIREBASE_CONFIG = {
  projectId: 'gpu-waste-auditor-2026',
  appId: '1:164243643676:web:b6efb139223b48c8a8aed9',
  storageBucket: 'gpu-waste-auditor-2026.firebasestorage.app',
  apiKey: 'AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo',
  authDomain: 'gpu-waste-auditor-2026.firebaseapp.com',
  messagingSenderId: '164243643676',
};

/* Ordered model fallback chain. Validate complete tool round trips and a final text response, not functionCall emission alone. */
export const MODEL_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
];

export const DEFAULT_MODEL = MODEL_CHAIN[0];

const ENDPOINT = (model) =>
  `https://firebasevertexai.googleapis.com/v1beta/projects/${FIREBASE_CONFIG.projectId}` +
  `/models/${model}:generateContent`;

/* Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 90_000;

/* Bound tool turns, not individual calls. A turn may contain several calls. Patrol needs scan, inspect, lookup, containment, draft, notification, and report steps. */
const MAX_TOOL_TURNS = 12;

/* Bound cross-model resumes while preserving completed work after upstream failures. */
const MAX_RESUMES = 2;

/* Retry count and default delay for short rate limits. */
const MAX_RETRIES = 2;
const RETRY_DEFAULT_WAIT_SEC = 15.0;

/* Long retry delays trigger model fallback. */
const LONG_WAIT_THRESHOLD_SEC = 90.0;

/* Current models require user-role tool responses. */
const FUNCTION_RESPONSE_ROLE = 'user';
/* Expose the HTTP status for quota detection. */
export class ApiError extends Error {
  constructor(status, bodyText) {
    super(bodyText || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = status;
    this.body = bodyText || '';
  }
}

/* Distinguish short rate limits from exhausted daily quota before retrying. */
export function describeError(err) {
  const text =
    err && err.body
      ? err.body
      : [err && err.name, err && err.code, err && err.message]
          .filter(Boolean)
          .join(' | ') || String(err);

  const isQuota =
    /\b429\b/.test(text) ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /quota exceeded/i.test(text) ||
    /rate.?limit/i.test(text);

  return { text, isQuota, retrySeconds: parseRetrySeconds(text) };
}

/* Parse retry delays such as 18h44m1.4s or 2.3s. */
export function parseRetrySeconds(text) {
  const hms = text.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?([0-9.]+)s/i);
  if (hms) {
    const [, h, m, s] = hms;
    return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
  }
  const plain = text.match(/retry in\s+([0-9.]+)\s*s/i);
  if (plain) return Number(plain[1]);
  const delay = text.match(/"?retryDelay"?\s*[:=]\s*"?([0-9.]+)s/i);
  if (delay) return Number(delay[1]);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/* POST generateContent with x-goog-api-key in the header and an abort timeout. */
async function postGenerateContent(model, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': FIREBASE_CONFIG.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(res.status, `Response is not valid JSON: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError(0, `Request timed out (${timeoutMs / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* Tool loop: user prompt, unchanged model parts (including thoughtSignature), then user-role function responses. */
async function runAgent({ prompt, state, modelName, onProgress, toolSpecs = TOOL_SPECS, carry = null }) {
  // Copy carried contents and tool calls so retries preserve prior progress without mutating saved arrays.
  const contents = carry?.contents
    ? carry.contents.map((c) => ({ ...c }))
    : [{ role: 'user', parts: [{ text: prompt }] }];
  const toolCalls = carry?.toolCalls ? carry.toolCalls.slice() : [];

  const notify = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    let data;
    try {
      data = await postGenerateContent(modelName, {
        contents,
        // Declare only tools available in this mode.
        tools: [{ functionDeclarations: toolSpecs }],
        // Use a low temperature for consistent decisions.
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      });
    } catch (err) {
      // Attach completed progress when transport or upstream requests fail.
      if (err && typeof err === 'object') {
        err.resume = { contents, toolCalls, turns: turn };
      }
      throw err;
    }

    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      const blocked = data.promptFeedback?.blockReason;
      throw new ApiError(
        0,
        blocked ? `Request blocked by safety policy: ${blocked}` : 'Model response contains no candidates',
      );
    }

    const parts = (candidates[0].content || {}).parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (calls.length > 0) {
      contents.push({ role: 'model', parts });

      const responses = [];
      for (const call of calls) {
        const name = call.name || '';
        const args = call.args || {};
        toolCalls.push({ name, args });
        notify(`Tool ${name}(${JSON.stringify(args)})`);
        // Await tools that read or write cluster state.
        const result = await dispatchTool(name, args, state);

        const functionResponse = { name, response: { result } };
        // Preserve the function-call ID in the paired response.
        if (call.id) functionResponse.id = call.id;
        responses.push({ functionResponse });
      }

      notify(`Returning results for ${calls.length} tool calls…`);
      contents.push({ role: FUNCTION_RESPONSE_ROLE, parts: responses });
      continue;
    }

    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    if (text) {
      return { mode: 'gemini', model: modelName, text, tool_calls: toolCalls };
    }

    const finishReason = candidates[0].finishReason;
    const empty = new ApiError(0, `Model returned neither tool calls nor text (finishReason=${finishReason})`);
    if (toolCalls.length) empty.resume = { contents, toolCalls, turns: turn };
    throw empty;
  }

  // Preserve completed calls on turn exhaustion, so resumed work retains its trace and avoids duplicate actions.
  //
  //
  const exhausted = new ApiError(0, `No final conclusion after ${MAX_TOOL_TURNS} tool turns`);
  if (toolCalls.length) exhausted.resume = { contents, toolCalls, turns: MAX_TOOL_TURNS };
  throw exhausted;
}

/* Try models in order. Return failures when none succeeds. */
async function tryModelChain({ prompt, state, onProgress, toolSpecs = TOOL_SPECS }) {
  const failures = [];
  /* Carry completed work across model attempts. */
  let carry = null;
  let resumes = 0;

  for (const modelName of MODEL_CHAIN) {
    let attempts = 0;
    // Retry a model only for short rate limits.
    while (attempts <= MAX_RETRIES) {
      try {
        const out = await runAgent({
          prompt, state, modelName, onProgress, toolSpecs, carry,
        });
        // Include each failed attempt for UI diagnostics.
        if (failures.length) out.degraded = failures;
        if (carry) out.resumed = true;
        return out;
      } catch (err) {
        const info = describeError(err);
        console.warn(`[ai] Model ${modelName} request failed: `, info.text);

        // Carry progress to the next model, subject to MAX_RESUMES.
        // Bound resumes to avoid spending quota on repeated failures.
        if (err?.resume && resumes < MAX_RESUMES) {
          const done = (err.resume.toolCalls || []).length;
          carry = err.resume;
          resumes += 1;
          if (typeof onProgress === 'function' && done > 0) {
            onProgress(`Upstream failure; preserving ${done} completed tool calls and trying the next model…`);
          }
        }

        if (info.isQuota) {
          const waitSec = info.retrySeconds ?? RETRY_DEFAULT_WAIT_SEC;
          if (waitSec <= LONG_WAIT_THRESHOLD_SEC && attempts < MAX_RETRIES) {
            attempts += 1;
            if (typeof onProgress === 'function') {
              onProgress(`Rate limited; retrying ${modelName} in ${Math.ceil(waitSec)}s…`);
            }
            await sleep((waitSec + 1) * 1000);
            continue;
          }
          failures.push({
            model: modelName,
            reason: waitSec > LONG_WAIT_THRESHOLD_SEC
              ? `Daily free quota exhausted (available in about ${Math.round(waitSec / 3600)} hours)`
              : `Rate limit persisted after ${MAX_RETRIES} retries`,
          });
          break;
        }

        failures.push({ model: modelName, reason: info.text.slice(0, 240) });
        break;
      }
    }
  }

  return { failures };
}

/* Use the same result shape for online and offline output. */
function packResult(state, extra = {}) {
  return {
    actions: state?.actions || [],
    executions: state?.executions || [],
    tickets: state?.tickets || [],
    notifications: state?.notifications || [],
    citations: state?.citations || [],
    ...extra,
  };
}

/* Preserve every online result field through the shared result exit, including tool_calls. */
function finishResult(state, mode, text, extra = {}, error = null) {
  // Online results must include a tool_calls array; missing records are pipeline errors.
  //
  const broken = mode === 'gemini' && !Array.isArray(extra.tool_calls);
  const calls = Array.isArray(extra.tool_calls) ? extra.tool_calls : [];

  // Each citation comes from a tool call. More citations than recorded calls indicates lost work.
  // Preserve completed calls on turn exhaustion, so resumed work retains its trace and avoids duplicate actions.
  const cited = (state?.citations || []).length;
  const lostWork = cited > calls.length;

  const notes = [];
  if (broken) {
    notes.push('Online result is missing tool_calls. This is a pipeline error; it does not mean no tools ran.');
  }
  if (lostWork) {
    notes.push(
      `${cited} tool references but only ${calls.length} recorded calls: `
      + 'Some call records were lost, possibly during model fallback. '
      + 'The trace is incomplete. Consult the reference map when checking the conclusion.',
    );
  }

  return packResult(state, {
    ...extra,
    tool_calls: calls,
    ...(notes.length ? { pipeline_error: notes.join(' ') } : {}),
    mode,
    text,
    model: extra.model || '',
    error,
  });
}

// ======================================================================
// Offline fallback uses deterministic rules without a model.
// ======================================================================
/* Keep the same rule baseline used by the benchmark. Do not add hidden offline inference. */
export function offlineCaseTriage(evidence, pre = null) {
  const p = pre || preAnalyze(evidence);
  const triage = ruleBasedTriage(evidence, p);
  const cls = triage.class;

  const actions = [];
  for (const a of suggestActions(cls)) {
    if (a.risk !== 'low') continue; // Offline recommendations are restricted to low-risk actions.
    if (actions.length >= 3) break;
    actions.push({
      id: `F${actions.length + 1}`,
      action_id: a.id,
      action_label: a.label,
      title: a.label,
      detail: `Common action for rule-matched ${a.applies_to.join('/')} failures.`,
      risk: a.risk,
      risk_label: RISK_LEVELS[a.risk].label,
      approval_requirement: RISK_LEVELS[a.risk].approval,
      affects: a.affects,
      cmds: a.cmds,
      params: a.params,
      expect: a.expect,
      rollback: a.rollback,
      classification: cls,
      classification_label: CLASSES[cls]?.label || cls,
      confidence: triage.confidence,
      evidence_refs: [],
      evidence: triage.basis.join('; '),
    });
  }

  return {
    classification: cls,
    should_rma: triage.should_rma,
    confidence: triage.confidence,
    basis: triage.basis,
    actions,
  };
}

/* Generate the four-part offline explanation. */
export function offlineCaseText(evidence, pre, result) {
  const c = pre?.confirmed || {};
  const L = [];
  const cls = result.classification;

  L.push('### 1. Decision (offline rule baseline)');
  L.push(
    `Classification **${cls}**, ${result.should_rma ? '**repair recommended**' : '**repair not recommended**'}, ` +
      `confidence ${(result.confidence * 100).toFixed(0)}%.`,
  );
  L.push('');

  L.push('### 2. Confirmed facts');
  if (c.xids?.length) {
    for (const x of c.xids) {
      L.push(
        `- Xid ${x.code} (${x.name || 'No knowledge-base record'}) × ${x.count}` +
          `${x.known ? '' : '; no record, do not infer its meaning'}`,
      );
    }
  } else {
    L.push('- No Xid codes detected in error text.');
  }
  for (const s of c.signatures || []) L.push(`- Matched signature: ${s.label}`);
  if (c.compat_ok === false) L.push('- Version stack has compatibility issues');
  if (c.memory_fit) L.push(`- GPU memory estimate: ${c.memory_required_gb} GB / capacity ${c.memory_capacity_gb} GB → ${c.memory_fit}`);
  L.push('');

  L.push('### 3. Rule recommendations');
  if (result.actions.length) {
    result.actions.forEach((a, i) => {
      L.push(`${i + 1}. **${a.action_label}** (${a.risk_label}; impact: ${a.affects})`);
    });
  } else {
    L.push('- No low-risk action matched.');
  }
  L.push('');

  L.push('### 4. Rule limitations');
  L.push(
    'Rules select the highest-vote classification and do not analyze trends or causal chains. '
      + 'They can miss cases requiring 30-day frequency analysis or separation of secondary events from root causes. '
      + 'This is the limited fallback path; full causal analysis requires a model.',
  );
  L.push('');
  L.push('> Generated by the **offline rule baseline** without a model.');
  return L.join('\n');
}

// ======================================================================
// ======================================================================
/* Case triage accepts a case, optional simulator client, progress callback, and online-enabled flag. */
export async function diagnose({
  caseObj, cluster = null, onProgress = null, enabled = true,
}) {
  const evidence = normalizeEvidence(caseObj);
  const pre = preAnalyze(evidence);
  const state = new ToolState(evidence, pre, { cluster });

  const finish = (mode, text, extra = {}, error = null) =>
    finishResult(state, mode, text, extra, error);

  if (!enabled) {
    const off = offlineCaseTriage(evidence, pre);
    // Register offline actions in state so the action list matches the explanation.
    state.actions = off.actions;
    return finish('offline', offlineCaseText(evidence, pre, off), { offline: off });
  }

  const prompt = buildCasePrompt(evidence, pre, pre.hints);
  if (typeof onProgress === 'function') {
    onProgress('Evidence sent to the model; waiting for tool calls…');
  }

  try {
    const res = await tryModelChain({
      prompt, state, onProgress, toolSpecs: toolSpecsFor('case'),
    });
    if (res && res.mode === 'gemini') return finish('gemini', res.text, res);

    const failures = res?.failures || [];
    const reason = failures.map((f) => `${f.model}: ${f.reason}`).join('; ');
    // Expose every model failure in the fallback output.
    return degradeCase(evidence, pre, state, finish, reason || 'All models unavailable', failures);
  } catch (err) {
    const info = describeError(err);
    return degradeCase(evidence, pre, state, finish, info.text.slice(0, 300));
  }
}

function degradeCase(evidence, pre, state, finish, error, degraded = []) {
  const off = offlineCaseTriage(evidence, pre);
  // Register fallback actions for consistent UI rendering.
  state.actions = off.actions;
  return finish(
    'fallback',
    `> Model requests failed; using the offline rule baseline. Reason: ${error}\n\n` + offlineCaseText(evidence, pre, off),
    { offline: off, degraded },
    error,
  );
}

// ======================================================================
// ======================================================================
/* Patrol discovers and contains simulated-cluster issues. A user starts the loop; production scheduling requires a separate service. */
export async function patrol({
  cluster, clusterMeta = {}, onProgress = null, enabled = true,
}) {
  if (!cluster) {
    return { mode: 'error', text: 'Cannot run patrol without a cluster connection.', error: 'No cluster connection' };
  }

  // Use an empty evidence context to store patrol citations.
  const evidence = normalizeEvidence({ id: 'patrol', title: 'On-call patrol', evidence: {} });
  const pre = preAnalyze(evidence);
  const state = new ToolState(evidence, pre, { cluster });

  const finish = (mode, text, extra = {}, error = null) =>
    finishResult(state, mode, text, extra, error);

  if (!enabled) {
    return finish('offline', await offlinePatrolText(cluster), {}, 'Online mode disabled');
  }

  const prompt = buildPatrolPrompt(clusterMeta);
  if (typeof onProgress === 'function') {
    onProgress('Starting on-call patrol; scanning the cluster…');
  }

  try {
    const res = await tryModelChain({
      prompt, state, onProgress, toolSpecs: toolSpecsFor('patrol'),
    });
    if (res && res.mode === 'gemini') return finish('gemini', res.text, res);
    const failures = res?.failures || [];
    const reason = failures.map((f) => `${f.model}: ${f.reason}`).join('; ');
    return finish(
      'fallback',
      await offlinePatrolText(cluster),
      { degraded: failures },
      reason || 'All models unavailable',
    );
  } catch (err) {
    const info = describeError(err);
    return finish('fallback', await offlinePatrolText(cluster), {}, info.text.slice(0, 300));
  }
}

/* Offline patrol reports discovered signals and executes no actions. */
export async function offlinePatrolText(cluster) {
  const nodes = await cluster.listNodes();
  const flagged = nodes
    .map((n) => ({ node: n.node, signals: nodeSignals(n) }))
    .filter((x) => x.signals.length);

  const L = [];
  L.push('### Patrol results (offline rule baseline)');
  L.push(`Scanned ${nodes.length} nodes; ${flagged.length} flagged.`);
  L.push('');
  for (const f of flagged) {
    L.push(`**${f.node}**`);
    for (const s of f.signals) L.push(`- ${s}`);
    L.push('');
  }
  L.push('### Rule limitations');
  L.push(
    'Rules list flagged signals; repair decisions require trend and causal analysis. '
      + 'Offline mode executes no actions. Action decisions require an online model.',
  );
  L.push('');
  L.push('> Generated by the **offline rule baseline** without a model.');
  return L.join('\n');
}

// ======================================================================
// UI helpers.
// ======================================================================
/* UI helpers. */
export function actionCatalog() {
  return ACTION_LIST.map((a) => ({
    ...a,
    risk_label: RISK_LEVELS[a.risk].label,
    risk_rule: RISK_LEVELS[a.risk].rule,
    approval_requirement: RISK_LEVELS[a.risk].approval,
    selectable: true,
  }));
}

export { getAction };
