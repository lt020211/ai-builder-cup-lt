import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { prepareReplay } from './demo_replay.mjs';

const recorder = new URL('./record_demo.mjs', import.meta.url);
const browser = readFileSync(new URL('./browser_check.mjs', import.meta.url), 'utf8');

test('recorder refuses implicit, live, unknown, and non-loopback replay modes before exporting replay labels', () => {
  for (const flags of [[], ['--mode=live'], ['--mode=other'], ['--mode=replay', '--url=https://example.invalid/'], ['--mode=replay', '--url=http://example.invalid/'], ['--mode=replay', '--mode=live']]) {
    const dir = mkdtempSync(join(tmpdir(), 'triage-mode-'));
    try {
      // Export never navigates, even before the fix. RED cannot contact a live service.
      const result = spawnSync(process.execPath, [recorder.pathname, '--dump-beats', '--calls=17', `--out=${dir}`, ...flags], { encoding: 'utf8', timeout: 10000 });
      assert.notEqual(result.status, 0, `must reject ${flags.join(' ') || 'missing mode'}`);
      assert.equal(existsSync(join(dir, 'beats.json')), false, 'invalid mode cannot export replay narration');
      assert.match(result.stderr, /mode|loopback/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('explicit local replay export identifies the recording mode and observed count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-mode-'));
  try {
    const result = spawnSync(process.execPath, [recorder.pathname, '--mode=replay', '--dump-beats', '--calls=17', `--out=${dir}`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(join(dir, 'beats.json'), 'utf8'));
    assert.equal(output.recordingMode, 'local-deterministic-replay');
    assert.match(output.beats.find(b => b.id === 'scan').caption, /17 tool calls/);
    assert.match(output.beats[0].caption, /local.*replay/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay intercepts external resource requests before network and refuses their audit', async () => {
  let listener;
  const sent = [];
  const cdp = {
    ws: { addEventListener: (event, callback) => { listener = callback; } },
    send: async (method, params) => { sent.push({ method, params }); },
    eval: async () => ({ audit: { reads: [], writes: [], models: [], unexpected: [] } }),
  };
  const audit = await prepareReplay(cdp, 'http://127.0.0.1:8908/');
  assert.deepEqual(sent[0], { method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*' }] } });
  for (const [requestId, url] of [['local', 'http://127.0.0.1:8908/js/app.js'], ['http', 'http://example.invalid/write'], ['https', 'https://example.invalid/write']]) {
    listener({ data: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId, request: { url } } }) });
  }
  assert.deepEqual(sent.slice(-3), [
    { method: 'Fetch.continueRequest', params: { requestId: 'local' } },
    { method: 'Fetch.failRequest', params: { requestId: 'http', errorReason: 'BlockedByClient' } },
    { method: 'Fetch.failRequest', params: { requestId: 'https', errorReason: 'BlockedByClient' } },
  ]);
  await assert.rejects(audit(), /Unexpected external request/);
  cdp.eval = async () => undefined;
  await assert.rejects(audit(), /transport was not installed/);
});

// Execute the real production assertion blocks with only page reads replaced.
// These fixtures cannot start Chrome or make any requests.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function block(start, end) {
  const i = browser.indexOf(start), j = browser.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `production assertion markers: ${start}`);
  return browser.slice(i, j);
}
async function run(source, values, page = {}) {
  let result;
  const cdp = { eval: async expression => vm.runInNewContext(expression, { document: {
    querySelector: selector => ({ textContent: page[selector] || '' }),
    querySelectorAll: selector => page[selector] || [],
  } }) };
  await new AsyncFunction('check', 'cdp', ...Object.keys(values), source)((name, ok) => { result = !!ok; }, cdp, ...Object.values(values));
  return result;
}

test('English tool counts require positive calls and reject the no-call placeholder', async () => {
  const source = block("check('Model made tool calls',", '\n\nconst verdictText');
  for (const [toolsRaw, toolCountTxt, expected] of [['lookup_xid', '4 tool calls', true], ['No tool calls: output came from offline rules', '4 tool calls', false], ['lookup_xid', '(no tool calls)', false], ['lookup_xid', '0 tool calls', false]]) {
    assert.equal(await run(source, { toolsRaw, toolCountTxt }), expected, `${toolsRaw}: ${toolCountTxt}`);
  }
});

test('English cluster summary extracts the flagged count', async () => {
  const source = block('const alertMeta = await cdp.eval(', "\n\nawait cdp.eval(`document.querySelector('#reset-cluster')");
  assert.equal(await run(source, {}, { '#cluster-meta': '6 nodes; 4 flagged · Live read from Cloud Firestore' }), true);
  assert.equal(await run(source, {}, { '#cluster-meta': '6 nodes; 0 flagged' }), false);
});

test('English patrol failure and idle placeholders cannot pass as a tool trace', async () => {
  const source = block("check(\n  'On-call tab displays the tool trace',", '\n\nconst evOk');
  for (const text of ['No patrol run yet', 'No tool calls: output came from offline rules', 'Patrol running…', 'Failed: model unavailable', 'Tool chain error']) {
    assert.equal(await run(source, { patrolToolsRaw: text, patrolToolCount: '17 tool calls' }, { '#patrol-tools li': [{}] }), false, text);
  }
  assert.equal(await run(source, { patrolToolsRaw: 'scan_cluster → inspect_node', patrolToolCount: '17 tool calls' }, { '#patrol-tools li': [{}, {}] }), true);
});

test('English verification outcomes are recognized without matching arbitrary prose', async () => {
  const source = block("check('Operation log contains verification results',", '\n\nconst ticketN');
  for (const [eventsTxt, expected] of [['low Verified Cordoned', true], ['low Verification failed', true], ['No operations recorded', false], ['No verified result', false]]) {
    assert.equal(await run(source, { eventsTxt }), expected, eventsTxt);
  }
});

test('every present ticket needs the English draft label; empty approvals use their empty state', async () => {
  const source = block("check('Ticket drafts are labeled for manual submission',", '\n\nconst notifN');
  for (const [ticketN, ticketsRaw, ticketLabels, empty, expected] of [[1, 'Draft · Awaiting human submission', ['Draft · Awaiting human submission'], '', true], [1, 'Submitted', ['Submitted'], '', false], [2, 'Draft · Awaiting human submission / Submitted', ['Draft · Awaiting human submission', 'Submitted'], '', false], [0, '', [], 'No pending approvals', true], [0, '', [], 'Loading', false]]) {
    assert.equal(await run(source, { ticketN, ticketsRaw, ticketLabels }, { '#tickets': empty }), expected, ticketsRaw || empty);
  }
});

test('empty notification queues use the English empty label', async () => {
  const source = block("check('Notification queue persisted to Firestore and read back',", "\n\nconsole.log('\\nE.");
  for (const [notifN, text, expected] of [[3, 'queued', true], [0, 'No notifications', true], [0, 'Loading', false]]) {
    assert.equal(await run(source, { notifN, notifCount: '' }, { '#notifications': text }), expected, text);
  }
});
