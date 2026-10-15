#!/usr/bin/env node
/** Offline catalog, approval, evidence-tier, and F8 benchmark checks. Run: node scripts/verify_triage.mjs. */

import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(ROOT, 'firebase', 'public', 'js');
const DATA_DIR = path.join(ROOT, 'firebase', 'public', 'data');

const load = (file) => import(pathToFileURL(path.join(JS_DIR, file)).href);

const kb = await load('kb.js');
const triage = await load('triage.js');
const tools = await load('tools.js');
const actions = await load('actions.js');

const casesDoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cases.json'), 'utf8'));
const allCases = casesDoc.cases || [];

const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  return cond;
};

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

// Reject untranslated domain output and comments; retain only the explicit input regex.
for (const file of [
  'js/actions.js', 'js/kb.js', 'js/triage.js', 'js/tools.js', 'js/cluster.js',
  'data/cases.json', 'data/cluster_seed.json',
]) {
  const source = fs.readFileSync(path.join(ROOT, 'firebase/public', file), 'utf8');
  const lines = source.split('\n');
  const first = lines.findIndex((text) => /\p{Script=Han}/u.test(
    file === 'js/kb.js' ? text.replace('/执行\\s*nvidia-smi\\s*超时/i', '') : text,
  ));
  ok(first === -1, `Domain language: firebase/public/${file}:${first + 1} contains Chinese presentation content`);
}

assert.deepEqual(actions.ACTION_LIST.map((a) => a.id), [
  'set_expandable_segments', 'reduce_micro_batch', 'enable_gradient_checkpointing',
  'restart_job', 'align_torch_wheel', 'cordon_node', 'reload_nvidia_modules',
  'gpu_reset', 'reboot_node', 'align_driver_version', 'drain_node', 'file_rma',
  'retire_gpu', 'bulk_driver_upgrade',
]);
assert.deepEqual(actions.ACTION_LIST.reduce((counts, a) => {
  counts[a.risk]++;
  return counts;
}, { low: 0, medium: 0, high: 0 }), { low: 6, medium: 5, high: 3 });
assert.deepEqual(Object.keys(kb.CLASSES), [
  'application', 'hardware', 'hardware_watch', 'environment', 'config', 'network', 'undetermined',
]);
assert.equal(tools.TOOL_SPECS.length, 10);
assert.deepEqual(tools.TOOL_SPECS.map((spec) => spec.name), [
  'scan_cluster', 'search_failure_signature', 'lookup_xid', 'check_compat', 'estimate_memory',
  'inspect_node', 'execute_action', 'draft_ticket', 'notify_operator', 'propose_fix',
]);
assert.equal(tools.toolSpecsFor('case').length, 6);
assert.equal(tools.toolSpecsFor('patrol').length, 10);
assert.deepEqual(allCases.map((c) => c.id), [
  'case-oom-batch', 'case-oom-fragmentation', 'case-nccl-nvlink', 'case-illegal-access',
  'case-driver-old', 'case-xid48-dbe', 'case-xid94-single', 'case-xid94-rising',
  'case-xid79-bus', 'case-gsp-119', 'case-driver-nvml-mismatch', 'case-smi-driver-dead',
  'case-gpu-hang-xid62', 'case-gpu-hang-deadlock',
]);
assert.ok(triage.matchSignatures('执行 nvidia-smi 超时').some((s) => s.id === 'smi_itself_hangs'));

// Presentation notes enter evidenceToText; translation must not introduce new log matches.
const expectedDomainSignals = {
  'case-oom-batch': [[], ['cuda_oom', 'cuda_oom_fragmentation', 'ib_link']],
  'case-oom-fragmentation': [[], ['cuda_oom', 'cuda_oom_fragmentation', 'ib_link']],
  'case-nccl-nvlink': [[], ['nccl_timeout', 'ib_link']],
  'case-illegal-access': [[[13, 1], [31, 1]], ['illegal_memory_access', 'unhandled_cuda_error']],
  'case-driver-old': [[], ['driver_too_old']],
  'case-xid48-dbe': [[[45, 1], [48, 1]], ['ib_link']],
  'case-xid94-single': [[[94, 1]], ['ib_link']],
  'case-xid94-rising': [[[94, 2], [95, 1]], ['ib_link']],
  'case-xid79-bus': [[[79, 1]], ['bus_error', 'ib_link']],
  'case-gsp-119': [[[119, 1], [120, 1]], []],
  'case-driver-nvml-mismatch': [[], ['nvml_mismatch', 'nvrm_api_mismatch']],
  'case-smi-driver-dead': [[[79, 1]], ['bus_error', 'smi_cannot_communicate', 'rm_init_adapter_failed']],
  'case-gpu-hang-xid62': [[[62, 1]], ['gpu_reset_failed']],
  'case-gpu-hang-deadlock': [[], ['nccl_timeout']],
};
for (const c of allCases) {
  const confirmed = triage.preAnalyze(triage.normalizeEvidence(c)).confirmed;
  assert.deepEqual([
    confirmed.xids.map(({ code, count }) => [code, count]),
    confirmed.signatures.map(({ id }) => id),
  ], expectedDomainSignals[c.id], `${c.id}: presentation translation changed extracted evidence`);
}

// ======================================================================
rule('A. Action catalog invariants');
// ======================================================================
const RISKS = ['low', 'medium', 'high'];
const placeholder = /<([A-Z0-9_]+)>/g;

for (const a of actions.ACTION_LIST) {
  ok(RISKS.includes(a.risk), `${a.id}: invalid risk (${a.risk})`);
  ok(typeof a.label === 'string' && a.label.length > 0, `${a.id}: missing label`);
  ok(typeof a.affects === 'string' && a.affects.length > 0, `${a.id}: missing impact description`);
  ok(Array.isArray(a.cmds) && a.cmds.length > 0, `${a.id}: missing commands`);
  ok(typeof a.expect === 'string' && a.expect.length > 0, `${a.id}: missing expected result`);
  ok(
    typeof a.rollback === 'string' && a.rollback.trim().length > 0,
    `${a.id}: rollback is required for inclusion in an execution package`,
  );

  const inCmd = new Set();
  for (const c of a.cmds) for (const m of c.matchAll(placeholder)) inCmd.add(m[1]);
  for (const p of inCmd) ok(a.params.includes(p), `${a.id}: command uses <${p}> without a params declaration`);
  for (const p of a.params) ok(inCmd.has(p), `${a.id}: params declares ${p} without a command placeholder`);
  ok(
    a.applies_to.every((c) => Object.hasOwn(kb.CLASSES, c)),
    `${a.id}: applies_to includes an unknown class (${a.applies_to.join(',')})`,
  );
}

const byRisk = {};
for (const a of actions.ACTION_LIST) byRisk[a.risk] = (byRisk[a.risk] || 0) + 1;

const selectable = actions.selectableActions();
const discIds = Object.keys(actions.DISCOURAGED_ACTIONS);
ok(
  !selectable.some((a) => discIds.includes(a.id)),
  `Discouraged actions appear in model candidates: ${discIds.join(',')}`,
);
ok(
  selectable.length === actions.ACTION_LIST.length,
  `Candidate count differs from catalog (${selectable.length} vs ${actions.ACTION_LIST.length})`,
);

line(`Actions: ${actions.ACTION_LIST.length}; ` +
  `risk distribution: low ${byRisk.low || 0} / medium ${byRisk.medium || 0} / high ${byRisk.high || 0}`);
line(`Model candidates: ${selectable.length}; excluded discouraged actions: ${discIds.join(', ')}`);

// ======================================================================
rule('B. Approval gates');
// ======================================================================
const approvalChecks = [
  {
    name: 'High risk without a change ticket is blocked',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: '', approver: 'litao' },
    expectOk: false,
  },
  {
    name: 'High risk without an approver is blocked',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: 'CHG-1', approver: '' },
    expectOk: false,
  },
  {
    name: 'High risk with ticket and approver is allowed',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: 'CHG-1', approver: 'litao' },
    expectOk: true,
  },
  {
    name: 'Medium risk without impact acknowledgment is blocked',
    args: { actionIds: ['reboot_node'], approvals: { reboot_node: { decision: 'approve' } } },
    expectOk: false,
  },
  {
    name: 'Medium risk with impact acknowledgment is allowed',
    args: { actionIds: ['reboot_node'], approvals: { reboot_node: { decision: 'approve', impact_ack: true } } },
    expectOk: true,
  },
  {
    name: 'Low risk approval needs no extra conditions',
    args: { actionIds: ['restart_job'], approvals: { restart_job: { decision: 'approve' } } },
    expectOk: true,
  },
  {
    name: 'Rejected low-risk action needs no approval conditions',
    args: { actionIds: ['restart_job'], approvals: { restart_job: { decision: 'reject' } } },
    expectOk: true,
  },
];

for (const c of approvalChecks) {
  const v = actions.validateApproval(c.args);
  const pass = c.expectOk ? v.ok : !v.ok;
  ok(pass, `Approval mismatch: ${c.name} (actual ok=${v.ok}; reasons: ${v.blocking.join('; ') || 'none'})`);
  line(`${pass ? 'PASS' : 'FAIL'} ${c.name}`);
}

// ======================================================================
rule('C. Risk override protection');
// ======================================================================
/** Minimal evidence for constructing ToolState. */
const emptyEvidence = triage.normalizeEvidence({ id: 'verify', evidence: {} });

function freshState() {
  return new tools.ToolState(emptyEvidence, triage.preAnalyze(emptyEvidence));
}

{
  const proto = tools.ToolState.prototype;
  const toolNames = Object.keys(tools.TOOL_PARAMS);
  const missing = toolNames.filter((n) => typeof proto[n] !== 'function');

  const declared = tools.TOOL_SPECS.map((s) => s.name).sort();
  const dispatchable = toolNames.slice().sort();
  const declaredNotDispatchable = declared.filter((n) => !dispatchable.includes(n));
  const dispatchableNotDeclared = dispatchable.filter((n) => !declared.includes(n));

  ok(missing.length === 0, `Missing ToolState methods: ${missing.join(', ')}`);
  ok(declaredNotDispatchable.length === 0, `Declared but not dispatchable: ${declaredNotDispatchable.join(', ')}`);
  ok(dispatchableNotDeclared.length === 0, `Dispatchable but not declared: ${dispatchableNotDeclared.join(', ')}`);

  line(`C0 Tool registry: ${toolNames.length} tools; ` +
    `${missing.length || declaredNotDispatchable.length || dispatchableNotDeclared.length ? 'FAIL mismatch' : 'PASS declarations, dispatch, and implementation agree'}`);
  line(`      ${toolNames.join(', ')}`);
}

{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    { action_id: 'install_cuda_13', title: 'x', detail: 'y', classification: 'environment', confidence: 0.9 },
    st,
  );
  ok(Boolean(out.error), 'C1: invented action_id must return an error');
  ok(st.actions.length === 0, 'C1: invented action_id must not register an action');
  ok(Array.isArray(out.available_actions) && out.available_actions.length > 0, 'C1: return available actions');
  line(`C1 Invented install_cuda_13 rejected; ${out.available_actions.length} candidates returned ${out.error ? 'PASS' : 'FAIL'}`);
}

{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    {
      action_id: 'file_rma',
      risk: 'low', // Attempt to override the catalog risk.
      risk_label: 'Low risk',
      title: 'A quick restart',
      detail: 'Try restarting first',
      classification: 'hardware',
      confidence: 0.6,
    },
    st,
  );
  const a = st.actions[0];
  ok(Boolean(a), 'C2: valid action_id must register');
  ok(a && a.risk === 'high', `C2: model risk must not override the catalog (actual ${a && a.risk})`);
  ok(a && a.risk_label === 'High risk', `C2: expected catalog risk label (actual ${a && a.risk_label})`);
  ok(
    a && typeof a.approval_requirement === 'string' && a.approval_requirement.includes('change ticket'),
    'C2: high-risk approval must require a change ticket',
  );
  line(`C2 Model risk=low with file_rma: catalog reports ${a.risk} / ${a.risk_label} ${a.risk === 'high' ? 'PASS' : 'FAIL'}`);
  line('      Commands and rollback come from the catalog:');
  line(`      ${a.cmds[0]}`);
  line(`      Rollback: ${String(a.rollback).slice(0, 56)}…`);
}

{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    { action_id: 'raise_nccl_timeout', title: 'x', detail: 'y', classification: 'network', confidence: 0.5 },
    st,
  );
  ok(Boolean(out.error), 'C3: discouraged action must be rejected');
  ok(st.actions.length === 0, 'C3: discouraged action must not register');
  line(`C3 raise_nccl_timeout rejected ${out.error ? 'PASS' : 'FAIL'}`);
}

{
  const st = freshState();
  await tools.dispatchTool('lookup_xid', { code: 94 }, st); // Produces T1.
  const out = await tools.dispatchTool(
    'propose_fix',
    {
      action_id: 'gpu_reset',
      title: 'Reset',
      detail: 'Reset this GPU',
      classification: 'hardware_watch',
      confidence: 0.5,
      evidence_refs: ['T1', 'T99'],
    },
    st,
  );
  const a = st.actions[0];
  ok(Array.isArray(a.evidence_refs) && a.evidence_refs.includes('T1'), 'C4: valid citation must remain');
  ok(!a.evidence_refs.includes('T99'), 'C4: invented T99 must be discarded');
  ok(Boolean(out.warning), 'C4: discarded refs must produce a warning');
  line(`C4 [T1, T99]: retained ${JSON.stringify(a.evidence_refs)}, discarded T99 ${out.warning ? 'PASS' : 'FAIL'}`);
}

{
  const st = freshState();
  const out = await tools.dispatchTool(
    'execute_action',
    { node: 'lyg2112', action_id: 'gpu_reset', reason: 'Try a reset' },
    st,
  );
  ok(out.refused === true, 'C5: medium-risk gpu_reset must be refused');
  ok(/Operator approval is required:/.test(out.error || ''), 'C5: refusal must explain operator approval');
  ok(Array.isArray(out.allowed_to_execute_now), 'C5: return directly executable actions');
  line(`C5 gpu_reset (medium risk): ${out.refused ? 'PASS refused' : 'FAIL allowed'}`);
  line(`      ${String(out.error).slice(0, 86)}`);
}

{
  const st = freshState();
  const out = await tools.dispatchTool(
    'execute_action',
    { node: 'lyg2112', action_id: 'file_rma', reason: 'Request repair directly' },
    st,
  );
  ok(out.refused === true, 'C6: high-risk file_rma must be refused');
  ok(/propose_fix/.test(out.instead || ''), 'C6: route refused actions through propose_fix');
  line(`C6 file_rma (high risk): ${out.refused ? 'PASS refused' : 'FAIL allowed'}`);
}

{
  const st = freshState();
  const ex = await tools.dispatchTool(
    'execute_action', { node: 'lyg2112', action_id: 'cordon_node', reason: 'x' }, st,
  );
  const sc = await tools.dispatchTool('scan_cluster', {}, st);
  ok(ex.executed !== true, 'C7: disconnected execution must not claim success');
  ok(Boolean(ex.error), 'C7: disconnected execution must return an error');
  ok(Boolean(sc.error), 'C7: disconnected scan must return an error');
  line(`C7 Disconnected execution and scan return errors ${ex.error && sc.error ? 'PASS' : 'FAIL'}`);
}

// ======================================================================
rule('C8. Evidence-tier contracts');
// ======================================================================
function evidenceCheck(name, verify) {
  try {
    verify();
    line(`PASS ${name}`);
  } catch (error) {
    ok(false, `${name}: ${error.message}`);
    line(`FAIL ${name}`);
  }
}

const { EVIDENCE_TIERS, evidenceTier } = tools;
evidenceCheck('C8 registry: ordered tiers and implemented producers', () => {
  assert.deepEqual(Object.keys(EVIDENCE_TIERS), ['snapshot', 'live', 'artifact']);
  assert.deepEqual(Object.values(EVIDENCE_TIERS).map((x) => x.order), [1, 2, 3]);
  assert.equal(EVIDENCE_TIERS.snapshot.implemented, true);
  assert.equal(EVIDENCE_TIERS.live.implemented, true);
  assert.equal(EVIDENCE_TIERS.artifact.implemented, false);
  assert.equal(evidenceTier('snapshot').evidence_tier, 'snapshot');
  assert.equal(evidenceTier('live').evidence_tier, 'live');
});
evidenceCheck('C8 artifact rejection has a stable error code', () => {
  assert.throws(() => evidenceTier('artifact'), { code: 'EVIDENCE_TIER_UNIMPLEMENTED' });
});
evidenceCheck('C8 unknown-tier rejection has a stable error code', () => {
  assert.throws(() => evidenceTier('unknown'), { code: 'EVIDENCE_TIER_UNKNOWN' });
});

const snapshotCase = allCases.find((c) => c.id === 'case-xid94-single');
const snapshotEvidence = triage.normalizeEvidence(snapshotCase);
const snapshotState = new tools.ToolState(snapshotEvidence, triage.preAnalyze(snapshotEvidence));
const snapshotResult = await tools.dispatchTool('inspect_node', { node: 'lyg2103' }, snapshotState);
evidenceCheck('C8 inspect_node snapshot retains its source and carries snapshot evidence', () => {
  assert.equal(snapshotResult.found, true);
  assert.equal(snapshotResult.source, 'case');
  assert.equal(snapshotResult.evidence_tier, 'snapshot');
  assert.equal(snapshotResult.provenance, EVIDENCE_TIERS.snapshot.provenance_text);
});

// Read-only cluster fixture: uses the same seed records as the offline pipeline test.
const seed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cluster_seed.json'), 'utf8'));
assert.deepEqual(Object.keys(seed.nodes), ['lyg2101', 'lyg2103', 'lyg2107', 'lyg2108', 'lyg2112', 'lyg2115']);
const cluster = {
  async getNode(node) { return seed.nodes[node] ? { ...seed.nodes[node], __id: node } : null; },
  async listNodes() { return Object.values(seed.nodes); },
};
const liveState = new tools.ToolState(emptyEvidence, triage.preAnalyze(emptyEvidence), { cluster });
const liveResult = await tools.dispatchTool('inspect_node', { node: 'lyg2112' }, liveState);
evidenceCheck('C8 inspect_node live retains its source and carries live evidence', () => {
  assert.equal(liveResult.found, true);
  assert.equal(liveResult.source, 'live');
  assert.equal(liveResult.evidence_tier, 'live');
  assert.equal(liveResult.provenance, EVIDENCE_TIERS.live.provenance_text);
});
const scanResult = await tools.dispatchTool('scan_cluster', {}, liveState);
evidenceCheck('C8 scan_cluster carries live evidence', () => {
  assert.equal(scanResult.scanned_nodes, 6);
  assert.equal(scanResult.evidence_tier, 'live');
  assert.equal(scanResult.provenance, EVIDENCE_TIERS.live.provenance_text);
});

const noEvidenceResults = [
  ['inspect_node missing node argument', await tools.dispatchTool('inspect_node', {}, freshState())],
  ['inspect_node missing telemetry', await tools.dispatchTool('inspect_node', { node: 'unknown-node' }, freshState())],
  ['inspect_node mismatched snapshot node', await tools.dispatchTool('inspect_node', { node: 'unknown-node' }, snapshotState)],
  ['inspect_node missing live node', await tools.dispatchTool('inspect_node', { node: 'unknown-node' }, liveState)],
  ['scan_cluster disconnected', await tools.dispatchTool('scan_cluster', {}, freshState())],
];
for (const [name, result] of noEvidenceResults) {
  evidenceCheck(`C8 ${name} does not claim an evidence tier`, () => {
    assert.ok(result.error);
    assert.equal(Object.hasOwn(result, 'evidence_tier'), false);
    assert.equal(Object.hasOwn(result, 'provenance'), false);
  });
}

// ======================================================================
rule('D. Case catalog structure');
// ======================================================================
const ids = new Set();
for (const c of allCases) {
  ok(!ids.has(c.id), `Duplicate case ID: ${c.id}`);
  ids.add(c.id);
  ok(Boolean(c.expected), `${c.id}: missing expected`);
  if (c.expected) {
    ok(Object.hasOwn(kb.CLASSES, c.expected.class), `${c.id}: invalid expected.class (${c.expected.class})`);
    ok(typeof c.expected.should_rma === 'boolean', `${c.id}: expected.should_rma must be boolean`);
    ok(Boolean(c.expected.trap), `${c.id}: missing trap`);
    ok(Boolean(c.expected.root_cause), `${c.id}: missing root_cause`);
  }
}

/** Use explicit IDs to avoid accidentally grouping unrelated cases. */
const PAIRS = {
  'Same Xid 94, different decisions': ['case-xid94-single', 'case-xid94-rising'],
  'Driver access failure, different causes': ['case-driver-nvml-mismatch', 'case-smi-driver-dead'],
  'GPU stall, different causes': ['case-gpu-hang-xid62', 'case-gpu-hang-deadlock'],
};
for (const [name, list] of Object.entries(PAIRS)) {
  for (const id of list) ok(ids.has(id), `Pair "${name}" references missing case ${id}`);
  ok(list.length >= 2, `Pair "${name}" needs at least two cases`);
}

const byClass = {};
for (const c of allCases) byClass[c.expected.class] = (byClass[c.expected.class] || 0) + 1;
const rmaYes = allCases.filter((c) => c.expected.should_rma).length;

line(`Cases: ${allCases.length}; RMA: ${rmaYes}; no RMA: ${allCases.length - rmaYes}`);
line(`Class distribution: ${Object.entries(byClass).map(([k, v]) => `${kb.CLASSES[k].short || k} ${v}`).join('; ')}`);
line('Paired cases:');
for (const [name, list] of Object.entries(PAIRS)) {
  line(`  · ${name}`);
  line(`    ${list.join('  vs  ')}`);
}

// ======================================================================
rule('E. F8 offline rule baseline');
// ======================================================================
line('Rule baseline: choose the highest-voted class; recommend RMA only for hardware.');
line('The baseline does not analyze trends or causal chains.\n');

const baselineRows = [];
for (const c of allCases) {
  const ev = triage.normalizeEvidence(c);
  const pre = triage.preAnalyze(ev);
  const r = triage.ruleBasedTriage(ev, pre);
  const cmp = triage.compareWithExpected(r, c.expected);
  baselineRows.push({ case: c, pre, rule: r, cmp });
}

const passCount = baselineRows.filter((r) => r.cmp.pass).length;
assert.equal(passCount, 11, 'F8 remains 11/14');
const classPass = baselineRows.filter((r) => r.cmp.class_ok).length;
const rmaPass = baselineRows.filter((r) => r.cmp.rma_ok).length;

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

line(`${pad('Case', 34)}${pad('Expected', 18)}${pad('Rule result', 18)}Result`);
line('─'.repeat(88));
for (const r of baselineRows) {
  const want = `${r.case.expected.class}${r.case.expected.should_rma ? ' +RMA' : ''}`;
  const got = `${r.rule.class}${r.rule.should_rma ? ' +RMA' : ''}`;
  line(`${pad(r.case.id, 34)}${pad(want, 18)}${pad(got, 18)}${r.cmp.pass ? 'PASS' : 'FAIL'}`);
}

line('');
line(`Rule accuracy (classification and RMA): ${passCount} / ${allCases.length}` +
  `  (${((100 * passCount) / allCases.length).toFixed(1)}%)`);
line(`  Classification: ${classPass} / ${allCases.length}; RMA: ${rmaPass} / ${allCases.length}`);

const wrong = baselineRows.filter((r) => !r.cmp.pass);
if (wrong.length) {
  line('');
  line('Baseline errors and missing context:');
  for (const r of wrong) {
    const detail = [
      `class ${r.cmp.got.class} ≠ expected ${r.cmp.want.class}`,
      r.cmp.rma_ok ? null : `RMA ${r.cmp.got.should_rma} ≠ expected ${r.cmp.want.should_rma}`,
    ].filter(Boolean).join('; ');
    line(`  · ${r.case.id}: ${detail}`);
    line(`    Baseline evidence: ${r.rule.basis.join(', ') || '(no matching evidence)'}`);
    line(`    Required context: ${r.case.expected.trap || '(not annotated)'}`);
  }
}

line('');
line('Baseline basis samples:');
for (const r of baselineRows.slice(0, 3)) {
  line(`  · ${r.case.id}: ${r.rule.basis[0] || 'none'}`);
}

// ======================================================================
rule(failures.length ? `Verification failed: ${failures.length} checks` : 'All verification checks passed');
// ======================================================================
for (const f of failures) line(`  ✗ ${f}`);
if (!failures.length) {
  line('Catalog invariants, approval gates, risk protection, and case structure passed.');
}
line('');
line(`F8 measured rule baseline: ${passCount}/${allCases.length}. ` +
  'Model results are available in the application.');
line('');

process.exit(failures.length ? 1 : 0);
