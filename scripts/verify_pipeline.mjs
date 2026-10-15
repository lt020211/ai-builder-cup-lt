/** Offline pipeline contracts use scripted fetch responses and an in-memory cluster; no live model or Firestore calls. Run: node scripts/verify_pipeline.mjs. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { diagnose, patrol, MODEL_CHAIN } from '../firebase/public/js/ai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  readFileSync(join(HERE, '..', 'firebase', 'public', 'data', 'cases.json'), 'utf8'),
).cases;

let pass = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

/** Return scripted model responses, including upstream failures, and retain request bodies for role and resume assertions. */
const requests = [];
let script = [];
let cursor = 0;

function installScript(items) {
  script = items;
  cursor = 0;
  requests.length = 0;
}

function geminiOk(parts, finishReason = 'STOP') {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ candidates: [{ content: { parts }, finishReason }] });
    },
  };
}

function geminiErr(status, body) {
  return { ok: false, status, async text() { return body; } };
}

globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  if (cursor >= script.length) {

    return geminiErr(500, `Fixture responses exhausted at request ${cursor + 1}`);
  }
  const item = script[cursor++];
  if (item && item.__error) return geminiErr(item.__error.status, item.__error.body);
  return geminiOk(item);
};

/** In-memory cluster client with the same event, ticket, and notification fields as cluster.js. */
function fakeCluster(seedNodes) {
  const store = JSON.parse(JSON.stringify(seedNodes));
  const events = [];
  return {
    _store: store,
    async listNodes() { return Object.values(store); },
    async getNode(id) { return store[id] ? { ...store[id] } : null; },
    hasEffect(actionId) { return actionId === 'cordon_node'; },
    async executeAction({ node, actionId, reason }) {
      const n = store[node];
      if (!n) return { ok: false, error: `Unknown node: ${node}` };
      const before = { ...n };
      n.cordoned = true;
      n.schedulable = false;
      const ifaces = { cordoned: true, schedulable: false };
      const describe = `Cordoned ${node}; ${(n.jobs || []).length} running jobs continue`;

      //   node / action_id / action_label / risk / actor / reason / describe /
      //   fields_written / status / verified / error / at

      const event = {
        node,
        action_id: actionId,
        action_label: 'Cordon the node',
        risk: 'low',
        actor: 'agent',
        reason,
        describe,
        fields_written: Object.keys(ifaces),
        status: 'ok',
        verified: true,
        error: null,
        at: new Date().toISOString(),
      };
      events.push(event);
      return {
        ok: true,
        before,
        after: { ...n },
        planned: { fields: ifaces, describe },
        verified: true,
        event,
      };
    },
    async createTicket(t) {
      return { __id: 'tk_test', ...t, status: 'draft', approved: false, ticket_no: '', approver: '' };
    },
    async notify(n) { return { __id: 'nt_test', ...n, status: 'queued' }; },
  };
}

const seed = JSON.parse(
  readFileSync(join(HERE, '..', 'firebase', 'public', 'data', 'cluster_seed.json'), 'utf8'),
).nodes;

function pickCase(id) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Missing case in cases.json: ${id}`);
  return c;
}

// ======================================================================
console.log('\nP0. Single result-finalization path');
{
  const SRC = readFileSync(join(HERE, '..', 'firebase', 'public', 'js', 'ai.js'), 'utf8');

  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  ok(/function finishResult\(/.test(CODE), 'Single finishResult() exit exists');

  const handRolled = /packResult\(\s*state\s*,\s*\{\s*mode\s*,\s*text\s*,\s*model:/.test(CODE);
  ok(
    !handRolled,
    'No local finish that discards tool_calls',
    handRolled ? 'Found packResult(state, { mode, text, model: … })' : '',
  );

  const callSites = (CODE.match(/finishResult\(state, mode, text, extra, error\)/g) || []).length;
  ok(callSites === 2, 'diagnose and patrol both use finishResult', `actual ${callSites}`);

  ok(
    /broken\s*=\s*mode === 'gemini' && !Array\.isArray\(extra\.tool_calls\)/.test(CODE),
    'Missing tool-call arrays on the gemini path are marked as pipeline errors',
  );
}

console.log('\nP1. Case triage retains the complete tool trace');
{
  installScript([
    [{ functionCall: { name: 'lookup_xid', args: { code: 94 } } }],
    [{ functionCall: { name: 'lookup_xid', args: { code: 95 } } }],
    [{ functionCall: { name: 'inspect_node', args: { node: 'lyg2112' } } }],
    [{
      functionCall: {
        name: 'propose_fix',
        args: {
          action_id: 'file_rma',
          title: 'Submit a hardware repair request (RMA)',
          detail: 'Rising Xid 94 with Xid 95 supports hardware degradation.',
          classification: 'hardware',
          confidence: 0.95,
          should_rma: true,
          evidence_refs: ['T1', 'T2', 'T3'],
        },
      },
    }],
    [{ text: 'Decision: hardware degradation; request RMA.' }],
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-rising') });

  ok(out.mode === 'gemini', 'Model path uses mode gemini', out.mode);
  ok(Array.isArray(out.tool_calls), 'tool_calls is an array', JSON.stringify(out.tool_calls));
  ok(
    Array.isArray(out.tool_calls) && out.tool_calls.length === 4,
    'All four tool calls are retained',
    `actual ${Array.isArray(out.tool_calls) ? out.tool_calls.length : 'undefined'}`,
  );
  const names = (out.tool_calls || []).map((c) => c.name);
  ok(
    names.join(',') === 'lookup_xid,lookup_xid,inspect_node,propose_fix',
    'Tool-call order and arguments are recorded',
    names.join(' → '),
  );
  ok(out.citations.length === 3, 'Three citations (T1/T2/T3)', `actual ${out.citations.length}`);
  ok(out.actions.length === 1, 'One recommendation registered', `actual ${out.actions.length}`);
  ok(out.actions[0]?.risk === 'high', 'Catalog assigns high risk', out.actions[0]?.risk);
  ok(
    (out.actions[0]?.evidence_refs || []).length === 3,
    'All three citations remain attached to the recommendation',
    JSON.stringify(out.actions[0]?.evidence_refs),
  );
}

console.log('\nP1b. Tool responses use the user role');
{

  const second = requests[1]?.body;
  const contents = second?.contents || [];
  ok(contents.length >= 3, 'Second request retains history', `${contents.length} entries`);
  ok(contents[0]?.role === 'user', 'Initial prompt uses user role', contents[0]?.role);
  ok(contents[1]?.role === 'model', 'Model content is returned intact with thoughtSignature', contents[1]?.role);
  const last = contents[contents.length - 1];
  ok(last?.role === 'user', 'Tool responses use user role', last?.role);
  ok(
    (last?.parts || []).some((p) => p.functionResponse),
    'Tool-result content contains functionResponse',
    JSON.stringify((last?.parts || []).map((p) => Object.keys(p))),
  );
  ok(
    (last?.parts || []).every((p) => p.functionResponse?.name),
    'Each functionResponse includes its tool name',
  );
}

console.log('\nP2. Patrol retains execution, tickets, notifications, and tool trace');
{
  installScript([
    [{ functionCall: { name: 'scan_cluster', args: { include_healthy: false } } }],
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'cordon_node', reason: 'Rising Xid 94; block new work first' },
      },
    }],
    [{
      functionCall: {
        name: 'draft_ticket',
        args: {
          node: 'lyg2112', action_id: 'file_rma', title: 'Request RMA for GPU 3',
          body: '53 Xid 94 events over 30 days with rising ECC.', priority: 'high',
          evidence_refs: ['T1'],
        },
      },
    }],
    [{
      functionCall: {
        name: 'notify_operator',
        args: {
          node: 'lyg2112', title: 'RMA approval pending',
          text: 'Node cordoned and draft ticket prepared.', severity: 'critical',
        },
      },
    }],
    [{ text: 'Patrol: one node cordoned and one ticket awaiting approval.' }],
  ]);

  const cluster = fakeCluster(seed);
  const out = await patrol({ cluster, clusterMeta: { node_count: 6 } });

  ok(out.mode === 'gemini', 'Model path uses mode gemini', out.mode);
  ok(
    Array.isArray(out.tool_calls) && out.tool_calls.length === 4,
    'All four patrol tool calls are retained',
    `actual ${Array.isArray(out.tool_calls) ? out.tool_calls.length : 'undefined'}`,
  );
  ok(out.executions.length === 1, 'One action executed', `actual ${out.executions.length}`);
  ok(
    out.executions[0]?.event?.verified === true,
    'Execution read-back verification is retained and passed',
    JSON.stringify(out.executions[0]?.event?.verified),
  );
  ok(out.tickets.length === 1, 'One ticket created', `actual ${out.tickets.length}`);
  ok(out.tickets[0]?.status === 'draft', 'Ticket remains draft', out.tickets[0]?.status);
  ok(out.tickets[0]?.approved === false, 'Ticket remains unapproved pending operator action', String(out.tickets[0]?.approved));
  ok(out.notifications.length === 1, 'One notification queued', `actual ${out.notifications.length}`);
  ok(out.notifications[0]?.status === 'queued', 'Notification remains queued', out.notifications[0]?.status);
  ok(cluster._store.lyg2112.cordoned === true, 'Cluster fixture state was updated');
}

console.log('\nP3. Approval gates take precedence over connection errors');
{
  installScript([
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'gpu_reset', reason: 'Try resetting' },
      },
    }],
    [{ text: 'Refused; use propose_fix.' }],
  ]);

  const out = await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });

  const fr = requests[1]?.body?.contents?.slice(-1)[0]?.parts?.[0]?.functionResponse;
  const result = fr?.response?.result || {};
  ok(result.refused === true, 'Medium-risk gpu_reset execution is refused', String(result.refused));
  ok(
    typeof result.error === 'string' && /Operator approval is required:/.test(result.error) && !/not connected to a cluster/.test(result.error),
    'Refusal explains approval rather than connection state',
    String(result.error).slice(0, 60),
  );
  ok(Array.isArray(result.allowed_to_execute_now), 'Return directly executable actions', `${(result.allowed_to_execute_now || []).length} actions`);
  ok(out.executions.length === 0, 'Refused action produces no execution record', `actual ${out.executions.length}`);
}

console.log('\nP4. No tool calls produces an empty trace');
{
  installScript([[{ text: 'Direct decision without tool calls.' }]]);
  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });
  ok(out.mode === 'gemini', 'Model response retains mode gemini', out.mode);
  ok(Array.isArray(out.tool_calls), 'tool_calls is an empty array', JSON.stringify(out.tool_calls));
  ok(out.tool_calls.length === 0, 'Zero tool calls recorded', `actual ${out.tool_calls.length}`);
  ok(out.citations.length === 0, 'No citations', `actual ${out.citations.length}`);
}

console.log('\nP5. Offline output registers actions without claiming tool calls');
{
  installScript([]); // Offline mode must not send requests.
  const out = await diagnose({ caseObj: pickCase('case-xid94-rising'), enabled: false });
  ok(out.mode === 'offline', 'Mode is offline', out.mode);
  ok(requests.length === 0, 'Offline mode sends no network requests', `${requests.length} requests`);
  ok(out.tool_calls.length === 0, 'No tool calls', `actual ${out.tool_calls.length}`);
  ok(
    out.actions.length > 0,
    'Offline recommendations are registered',
    `actual ${out.actions.length} actions`,
  );
  ok(
    out.actions.every((a) => a.risk === 'low'),
    'Offline recommendations are low risk only',
    out.actions.map((a) => a.risk).join(','),
  );
}

console.log('\nP6. Non-converging tools trigger fallback');
{

  installScript(Array.from({ length: 20 }, () => [
    { functionCall: { name: 'lookup_xid', args: { code: 94 } } },
  ]));
  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });
  ok(out.mode === 'fallback', 'Non-convergence falls back to the rule baseline', out.mode);
  ok(typeof out.error === 'string' && out.error.length > 0, 'Result includes the failure reason', String(out.error).slice(0, 80));
  ok(out.degraded?.length > 0, 'Fallback reasons are retained', `${out.degraded?.length || 0} entries`);
}

console.log('\nP7. Mode limits tool capabilities');
{

  installScript([[{ text: 'Direct decision.' }]]);
  await diagnose({ caseObj: pickCase('case-xid94-single') });
  const caseTools = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

  ok(caseTools.length > 0, 'Case mode declares tools', `${caseTools.length} tools`);
  for (const forbidden of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(
      !caseTools.includes(forbidden),
      `Case mode does not expose ${forbidden}`,
    );
  }
  for (const needed of ['lookup_xid', 'inspect_node', 'propose_fix']) {
    ok(caseTools.includes(needed), `Case mode retains ${needed}`);
  }

  installScript([[{ text: 'Patrol summary.' }]]);
  await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });
  const patrolTools = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

  ok(patrolTools.length === 10, 'Patrol exposes all ten tools', `actual ${patrolTools.length}`);
  for (const needed of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(patrolTools.includes(needed), `Patrol exposes ${needed}`);
  }
  ok(
    patrolTools.length > caseTools.length,
    'Modes expose different tool capabilities',
    `case ${caseTools.length} / patrol ${patrolTools.length}`,
  );
}

console.log('\nP8. Prompts reference only available tools');
{
  const ALL = [
    'scan_cluster', 'search_failure_signature', 'lookup_xid', 'check_compat',
    'estimate_memory', 'inspect_node', 'execute_action', 'draft_ticket',
    'notify_operator', 'propose_fix',
  ];
  const mentioned = (text) => ALL.filter((t) => new RegExp(`\\b${t}\\b`).test(text || ''));

  installScript([[{ text: 'Decision.' }]]);
  await diagnose({ caseObj: pickCase('case-xid94-single') });
  const casePrompt = requests[0]?.body?.contents?.[0]?.parts?.[0]?.text || '';
  const caseDeclared = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  const caseMentioned = mentioned(casePrompt);
  const caseOrphans = caseMentioned.filter((t) => !caseDeclared.includes(t));
  ok(
    caseOrphans.length === 0,
    'Case prompt has no unavailable tool references',
    caseOrphans.length ? `Undeclared references: ${caseOrphans.join(', ')}` : `${caseMentioned.length} references, all declared`,
  );

  installScript([[{ text: 'Patrol summary.' }]]);
  await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });
  const patrolPrompt = requests[0]?.body?.contents?.[0]?.parts?.[0]?.text || '';
  const patrolDeclared = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  const patrolMentioned = mentioned(patrolPrompt);
  const patrolOrphans = patrolMentioned.filter((t) => !patrolDeclared.includes(t));
  ok(
    patrolOrphans.length === 0,
    'Patrol prompt has no unavailable tool references',
    patrolOrphans.length ? `Undeclared references: ${patrolOrphans.join(', ')}` : `${patrolMentioned.length} references, all declared`,
  );

  for (const t of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(
      patrolMentioned.includes(t) && !caseMentioned.includes(t),
      `${t} appears only in the patrol prompt`,
    );
  }
}

console.log('\nP9. Resume after an upstream 500 without replaying completed work');
{
  installScript([
    [{ functionCall: { name: 'scan_cluster', args: { include_healthy: false } } }],
    { __error: { status: 500, body: 'upstream internal error' } },
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'cordon_node', reason: 'Block new work first' },
      },
    }],
    [{
      functionCall: {
        name: 'draft_ticket',
        args: {
          node: 'lyg2112', action_id: 'file_rma', title: 'Request RMA',
          body: 'Xid 94 frequency is rising.', evidence_refs: [],
        },
      },
    }],
    [{
      functionCall: {
        name: 'notify_operator',
        args: { node: 'lyg2112', title: 'RMA approval pending', text: 'Node cordoned.', severity: 'critical' },
      },
    }],
    [{ text: 'Patrol: node cordoned, ticket drafted, notification queued.' }],
  ]);

  const out = await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });

  ok(out.resumed === true, 'Result records a resumed session', String(out.resumed));
  ok(out.mode === 'gemini', 'A model completes the resumed session', out.mode);
  ok(
    (out.tool_calls || []).length === 4,
    'Four calls survive model switching, including the earlier scan_cluster',
    (out.tool_calls || []).map((c) => c.name).join(' → '),
  );
  ok(
    out.tool_calls[0]?.name === 'scan_cluster',
    'First call retains the previous model identity',
    out.tool_calls[0]?.name,
  );
  ok(out.tickets.length === 1, 'Resumed session retains the ticket', `actual ${out.tickets.length}`);
  ok(out.notifications.length === 1, 'Resumed session retains the notification', `actual ${out.notifications.length}`);
  ok(out.executions.length === 1 && out.executions[0]?.event?.verified === true, 'Cordon execution and verification passed');
  ok(
    (out.degraded || []).some((d) => /500/.test(String(d.reason)) || /upstream/.test(String(d.reason))),
    'Upstream failure is recorded in degraded',
    (out.degraded || []).map((d) => `${d.model}: ${String(d.reason).slice(0, 40)}`).join('  |  '),
  );
}

console.log('\nP10. Preserve completed calls when the turn limit is reached');
{

  installScript([
    ...Array.from({ length: 12 }, () => [
      { functionCall: { name: 'lookup_xid', args: { code: 94 } } },
    ]),
    [{ text: 'Decision: investigate hardware.' }],
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });

  ok(out.resumed === true, 'Turn limit resumes with a different model', String(out.resumed));
  ok(out.mode === 'gemini', 'A model completes the session', out.mode);
  ok(
    (out.tool_calls || []).length === 12,
    'All twelve calls remain in the trace',
    `actual ${(out.tool_calls || []).length}`,
  );
  ok(
    out.citations.length === out.tool_calls.length,
    'Citation count matches tool-call count',
    `${out.citations.length} citations / ${out.tool_calls.length} calls`,
  );
  ok(!out.pipeline_error, 'No pipeline error', String(out.pipeline_error || '(none)'));
}

console.log('\nP11. Citation/trace mismatch is reported as a pipeline error');
{

  installScript([
    [{ functionCall: { name: 'lookup_xid', args: { code: 94 } } }],
    { __error: { status: 500, body: 'boom 1' } },
    { __error: { status: 500, body: 'boom 2' } },
    { __error: { status: 500, body: 'boom 3' } },
    { __error: { status: 500, body: 'boom 4' } },
    { __error: { status: 500, body: 'boom 5' } },
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });

  ok(out.mode === 'fallback', 'Persistent upstream failure falls back to rules', out.mode);
  ok(out.citations.length > 0, 'Earlier citations remain', `${out.citations.length} citations`);
  ok(out.tool_calls.length === 0, 'Missing trace is empty', `${out.tool_calls.length} calls`);
  ok(
    typeof out.pipeline_error === 'string' && /tool references/.test(out.pipeline_error)
      && /recorded calls/.test(out.pipeline_error),
    'Pipeline error explains the citation/trace mismatch',
    String(out.pipeline_error || '(none)').slice(0, 90),
  );
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  Contract checks passed: ${pass} / ${pass + failures.length}`);
if (failures.length) {
  console.log('  Failed checks:');
  for (const f of failures) console.log(`    · ${f}`);
}
console.log(`  Model chain: ${MODEL_CHAIN.join(' → ')}; all model responses are local fixtures.`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failures.length ? 1 : 0);
