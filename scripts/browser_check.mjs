/**
 * Check UI assertions and capture console errors in a real Chrome session.
 * Local replay: node scripts/browser_check.mjs --mode=replay --url=http://127.0.0.1:8908/
 * Live acceptance (external gate): node scripts/browser_check.mjs [http://127.0.0.1:8899/]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayOptions, prepareReplay } from './demo_replay.mjs';

const argv = process.argv.slice(2);
const REPLAY = argv.some(a => a.startsWith('--mode='));
const APP_URL = REPLAY ? replayOptions(argv).url : argv[0] || 'http://127.0.0.1:8899/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor(Math.random() * 200);

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`)
          .join(' ');
        this.consoleLogs.push({ level: msg.params.type, text });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.exceptions.push(
          d.exception?.description || d.text || JSON.stringify(d).slice(0, 300)
        );
      }
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry || {};
        if (e.level === 'error') this.consoleLogs.push({ level: 'error', text: `${e.text} ${e.url || ''}` });
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** Evaluate in the page; awaitPromise waits for async expressions. */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  /** Poll until the expression is truthy or the timeout expires. */
  async waitFor(expression, { timeout = 20000, interval = 250, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression, { awaitPromise: false });
        if (last) return last;
      } catch (e) {
        last = `Error: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }
}

// Disable the nested sandbox only for this isolated Chrome instance.
// TRIAGE_PROFILE reuses cached model results across checks.
const PROFILE = REPLAY ? '' : process.env.TRIAGE_PROFILE || '';
const profile = PROFILE || mkdtempSync(join(tmpdir(), 'triage-chk-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  ...(REPLAY ? ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'] : []),
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-gpu-sandbox',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  // Keep externally supplied profiles; remove only the temporary profile.
  if (!PROFILE) {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
process.on('exit', cleanup);

async function getTargetWebSocket() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      // Select a page target rather than an extension or browser UI target.

      const pages = list.filter((t) => t.type === 'page');
      const page = pages.find((t) => t.url === 'about:blank') || pages[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {

    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome debugging port unavailable. Last stderr:\n${chromeErr.slice(-800)}`);
}

const wsUrl = await getTargetWebSocket();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
const auditReplay = REPLAY ? await prepareReplay(cdp, APP_URL) : null;

console.log(`\nLoading ${APP_URL} (${REPLAY ? 'LOCAL DETERMINISTIC REPLAY; no external writes' : 'LIVE acceptance; model requests and shared simulated writes'})\n`);
await cdp.send('Page.navigate', { url: APP_URL });

const ready = await cdp.waitFor(
  `document.querySelectorAll('#case-select option').length`,
  { timeout: 25000, label: 'Case selector' }
);

console.log('A. Page and module loading');
check('app.js initialized and loaded the case library', Number(ready) > 0, `${ready} options`);
check('No uncaught exceptions', cdp.exceptions.length === 0,
  cdp.exceptions.length ? `\n      ${cdp.exceptions.slice(0, 5).join('\n      ')}` : '');
const errLogs = cdp.consoleLogs.filter((l) => l.level === 'error' || l.level === 'warning');
check('No console errors', errLogs.filter((l) => l.level === 'error').length === 0,
  errLogs.length ? `\n      ${errLogs.slice(0, 6).map((l) => `[${l.level}] ${l.text}`).join('\n      ')}` : '');

const caseCount = await cdp.eval(`document.querySelectorAll('#case-select option').length`);
check('Case library contains 14 cases', caseCount === 14, `observed ${caseCount}`);
check('Triage and patrol start idle', !!(await cdp.eval(
  `document.querySelector('#tab-case[data-state="idle"]') && document.querySelector('#tab-patrol[data-state="idle"]')`
)));

console.log('\nB. Benchmark (local rule baseline)');
const benchRule = await cdp.eval(`document.querySelector('#bench-rule').textContent.trim()`);
check('Rule baseline is ready and displayed', /^\d+\s*\/\s*\d+$/.test(benchRule), `displayed: ${benchRule}`);
check('Rule baseline matches the scoring script (11 / 14)', benchRule.replace(/\s/g, '') === '11/14', `displayed: ${benchRule}`);

const benchRows = await cdp.eval(`document.querySelectorAll('#bench-tbl tr').length`);
check('Benchmark table rendered', benchRows > 0, `${benchRows} rows`);

console.log('\nC. Case triage');

await cdp.eval(`(() => { const s=document.querySelector('#case-select'); s.value='case-xid94-rising'; s.dispatchEvent(new Event('change')); return true; })()`);
const caseRendered = await cdp.waitFor(
  `document.querySelector('#tab-case[data-state="complete"]') && document.querySelector('#case-result').style.display !== 'none' && document.querySelector('#tools').children.length > 0`,
  { timeout: 60000 }
);
check('Case triage rendered its result', !!caseRendered);
const toolN = await cdp.eval(`document.querySelectorAll('#tools li').length`);
const caseStatus = await cdp.eval(`document.querySelector('#case-status').textContent.trim()`);
const modeTxt = await cdp.eval(`document.querySelector('#verdict-mode').textContent.trim()`);
check('Tool trace rendered, including any no-call status', Number(toolN) > 0, `${toolN} entries; status: ${caseStatus}; ${modeTxt}`);

// Print the trace to distinguish tool calls from the no-call placeholder.

const toolsRaw = await cdp.eval(`[...document.querySelectorAll('#tools li')].map(li => li.textContent.trim()).join(' ｜ ')`);
const toolCountTxt = await cdp.eval(`document.querySelector('#toolcount').textContent.trim()`);
console.log(`      #toolcount = ${toolCountTxt}`);
console.log(`      Raw trace = ${toolsRaw.slice(0, 600)}`);
check('Model made tool calls',
  !/No tool calls/i.test(toolsRaw) && /^[1-9]\d* tool calls$/.test(toolCountTxt),
  toolCountTxt);

const verdictText = await cdp.eval(`document.querySelector('#verdict').textContent.trim().slice(0,60)`);
check('Verdict contains a result or an insufficient-evidence status', verdictText.length > 0, `「${verdictText.replace(/\s+/g,' ')}」`);
const actsN = await cdp.eval(`document.querySelectorAll('#actions .act').length`);
const actsRaw = await cdp.eval(`[...document.querySelectorAll('#actions .act')].map(a => a.textContent.replace(/\\s+/g,' ').trim().slice(0,120)).join(' ｜ ')`);
console.log(`      Action groups = ${await cdp.eval(`[...document.querySelectorAll('#actions .group')].map(g => g.className).join(',')`)}`);
console.log(`      Raw actions = ${actsRaw.slice(0, 600)}`);
check('Actions rendered by risk level', Number(actsN) > 0, `${actsN} action cards`);

console.log('\nD. On-call agent (Firestore round trip)');

await cdp.eval(`(() => { for (const b of document.querySelectorAll('#tabs button')) if (b.dataset.tab==='patrol') b.click(); return true; })()`);
const nodeCount = await cdp.waitFor(`document.querySelectorAll('#nodes .node').length`, { timeout: 25000 });
check('Cluster nodes read from Firestore', Number(nodeCount) === 6, `observed ${nodeCount} node cards`);
const clusterMeta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);
check('Cluster summary identifies its data source', /Firestore/.test(clusterMeta), `「${clusterMeta}」`);

const alertMeta = await cdp.eval(
  `(() => { const t=document.querySelector('#cluster-meta').textContent; const m=t.match(/(\\d+) flagged/); return m?Number(m[1]):-1; })()`
);
check('Alert node count identified (4 in seed data)', Number(alertMeta) === 4, `observed ${alertMeta}`);

await cdp.eval(`document.querySelector('#reset-cluster').click()`);
const clusterReset = await cdp.waitFor(`document.querySelector('#cluster-status[data-state="reset"]')`, { timeout: 25000, label: 'Reset complete' });
check('Cluster reset and readback complete', !!clusterReset);

async function readNode(node) {
  return cdp.eval(`(async () => {
    const url = 'https://firestore.googleapis.com/v1/projects/' + window.__PROBE__.projectId +
      '/databases/(default)/documents/cluster/' + ${JSON.stringify(node)} + '?key=' + window.__PROBE__.apiKey;
    const r = await fetch(url);
    return { status: r.status, body: await r.json() };
  })()`);
}

const meta = await cdp.eval(`(async () => {
  const m = await import('./js/cluster.js');
  return { projectId: m.CLUSTER_META.projectId, apiKey: m.CLUSTER_META.apiKey, database: m.CLUSTER_META.database };
})()`);
await cdp.eval(`window.__PROBE__ = ${JSON.stringify(meta)}; true`);
check('Firestore project configuration available', !!meta?.projectId, meta?.projectId || '');

const pre = await readNode('lyg2112');
const preCordoned = pre?.body?.fields?.cordoned?.booleanValue;
check('lyg2112 is not cordoned before patrol', preCordoned !== true, `cordoned=${preCordoned}`);

console.log('  Starting patrol (uses the model; fallback should still complete low-risk actions)');
const patrolT0 = Date.now();
await cdp.eval(`document.querySelector('#run-patrol').click()`);

// Allow five minutes for upstream retries and record elapsed time.

// Observe both completion and operation-log entries during patrol.

let patrolDone = false;
let sawLiveLog = false;
let liveLogAtSec = null;
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  const state = await cdp.eval(`document.querySelector('#tab-patrol').dataset.state`);
  const n = await cdp.eval(`document.querySelectorAll('#events li.ok, #events li.fail').length`);
  const done = state === 'complete' || state === 'failed';
  if (!done && Number(n) > 0 && !sawLiveLog) {
    sawLiveLog = true;
    liveLogAtSec = ((Date.now() - patrolT0) / 1000).toFixed(1);
  }
  if (done) { patrolDone = state === 'complete'; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
const patrolSec = ((Date.now() - patrolT0) / 1000).toFixed(1);
console.log(`      Patrol duration = ${patrolSec}s`);
check('Patrol completed and produced a report', !!patrolDone, `${patrolSec}s`);
check(
  'Operation-log entries appeared during patrol',
  sawLiveLog || !patrolDone,
  sawLiveLog ? `first entry at ${liveLogAtSec}s` : 'not observed; patrol incomplete',
);

const post = await readNode('lyg2112');
const postCordoned = post?.body?.fields?.cordoned?.booleanValue;
check('lyg2112 cordoned is true in Firestore after patrol', postCordoned === true, `cordoned=${postCordoned}`);

const patrolToolsRaw = await cdp.eval(`[...document.querySelectorAll('#patrol-tools li')].map(li => li.textContent.trim()).join(' ｜ ')`);
const patrolToolCount = await cdp.eval(`document.querySelector('#patrol-toolcount').textContent.trim()`);
console.log(`      Patrol tool trace = ${patrolToolCount}`);
console.log(`      Raw trace = ${patrolToolsRaw.slice(0, 700)}`);
check(
  'On-call tab displays the tool trace',
  Number(await cdp.eval(`document.querySelectorAll('#patrol-tools li').length`)) > 0
    && /^[1-9]\d* tool calls$/.test(patrolToolCount)
    && !/No patrol run yet|No tool calls|Patrol running|Failed:|Tool chain error/i.test(patrolToolsRaw),
  patrolToolCount,
);

const evOk = await cdp.eval(`document.querySelectorAll('#events li.ok, #events li.fail').length`);
const evFail = await cdp.eval(`document.querySelectorAll('#events li.fail').length`);
const eventsN = evOk;
const eventsTxt = await cdp.eval(`document.querySelector('#events').textContent`);
const eventsRaw = await cdp.eval(`[...document.querySelectorAll('#events li')].map(li => li.textContent.replace(/\\s+/g,' ').trim()).join('  ／／  ')`);
const patrolStatus = await cdp.eval(`document.querySelector('#patrol-status').textContent.trim()`);
const patrolMode = await cdp.eval(`document.querySelector('#patrol-mode').textContent.trim()`);
console.log(`      Patrol status = ${patrolStatus}`);
console.log(`      Patrol mode = ${patrolMode}`);
console.log(`      Raw operation log = ${eventsRaw.slice(0, 700)}`);
check('Operation log contains executed actions', Number(eventsN) > 0, `${eventsN} entries with outcomes`);
check('No failed action verifications', Number(evFail) === 0, `${evFail} failures`);
check('Operation log contains verification results', /\b(?:Verified|Verification failed)\b/.test(eventsTxt),
  (eventsTxt.match(/\b(?:Verified|Verification failed)\b/g) || []).slice(0, 4).join(' / ') || 'No verification result found');

const ticketN = await cdp.eval(`document.querySelectorAll('#tickets .tk').length`);
const ticketsRaw = await cdp.eval(`[...document.querySelectorAll('#tickets .tk')].map(t => t.textContent.replace(/\\s+/g,' ').trim().slice(0,180)).join('  ／／  ')`);
const ticketLabels = await cdp.eval(`[...document.querySelectorAll('#tickets .tk .h > .badge')].map(t => t.textContent.trim())`);
console.log(`      Raw tickets = ${ticketsRaw.slice(0, 500) || '(empty)'}`);
// Report optional tickets and notifications even if the model did not reach those steps.
check('Ticket drafts are labeled for manual submission',
  Number(ticketN) > 0
    ? ticketLabels.length === Number(ticketN) && ticketLabels.every(label => label === 'Draft · Awaiting human submission')
    : (await cdp.eval(`document.querySelector('#tickets').textContent`)).trim() === 'No pending approvals',
  `${ticketN} tickets; ${ticketLabels.join(' / ') || 'no pending approvals'}`);

const notifN = await cdp.eval(`document.querySelectorAll('#notifications .tk').length`);
const notifCount = await cdp.eval(`document.querySelector('#notif-count').textContent.trim()`);
console.log(`      Raw notifications = ${(await cdp.eval(`document.querySelector('#notifications').textContent.replace(/\\s+/g,' ').trim()`)).slice(0, 400)}`);
check('Notification queue persisted to Firestore and read back', Number(notifN) > 0 || (await cdp.eval(`document.querySelector('#notifications').textContent`)).trim() === 'No notifications',
  `${notifN} entries; count: ${notifCount || 'empty'}`);

console.log('\nE. Actions and approvals');
await cdp.eval(`(() => { for (const b of document.querySelectorAll('#tabs button')) if (b.dataset.tab==='actions') b.click(); return true; })()`);
const riskN = await cdp.eval(`document.querySelectorAll('#risk-levels > *').length`);
check('All three risk levels rendered', Number(riskN) === 3, `observed ${riskN}`);
const actRows = await cdp.eval(`document.querySelectorAll('#action-tbl tr').length`);
check('Action table contains 14 actions and a header', Number(actRows) === 15, `observed ${actRows} rows`);
const discN = await cdp.eval(`document.querySelectorAll('#discouraged > *').length`);
check('Discouraged actions rendered', Number(discN) >= 1, `${discN} entries`);

// Check exceptions again after async model and Firestore operations.

console.log('\nF. Final checks');
check('No uncaught exceptions after the full run', cdp.exceptions.length === 0,
  cdp.exceptions.length ? `\n      ${cdp.exceptions.slice(0, 5).join('\n      ')}` : '');
const lateErrors = cdp.consoleLogs.filter((l) => l.level === 'error');
// Report handled upstream model failures separately from application errors.

const upstreamErrors = lateErrors.filter((l) => /firebasevertexai\.googleapis\.com/.test(l.text));
const ownErrors = lateErrors.filter((l) => !/firebasevertexai\.googleapis\.com/.test(l.text));
check('No application console errors after the full run', ownErrors.length === 0,
  ownErrors.length ? `\n      ${ownErrors.slice(0, 6).map((l) => l.text).join('\n      ')}` : '');
if (upstreamErrors.length) {
  console.log(`  Upstream model failures handled by fallback or continuation: ${upstreamErrors.length}`);
  for (const e of upstreamErrors.slice(0, 4)) console.log(`      ${e.text.slice(0, 160)}`);
}

console.log(`\n${'='.repeat(56)}`);
console.log(`  Passed ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  Failed checks:`);
  for (const f of failures) console.log(`    · ${f}`);
  const errs = cdp.consoleLogs.filter((l) => l.level === 'error');
  if (errs.length) {
    console.log(`\n  Console errors (first 10):`);
    for (const e of errs.slice(0, 10)) console.log(`    [${e.level}] ${e.text.slice(0, 220)}`);
  }
  if (cdp.exceptions.length) {
    console.log(`\n  Uncaught exceptions (first 5):`);
    for (const e of cdp.exceptions.slice(0, 5)) console.log(`    ${e.slice(0, 300)}`);
  }
}
console.log(`${'='.repeat(56)}\n`);

if (auditReplay) await auditReplay(argv.find(a => a.startsWith('--audit='))?.slice(8));
ws.close();
cleanup();
process.exit(fail ? 1 : 0);
