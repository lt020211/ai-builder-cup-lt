#!/usr/bin/env node
/**
 * Capture app tabs and optional element bounds for deck crops.
 * Usage: node scripts/capture_shots.mjs [url] [outDir] [--case id] [--boxes file]
 * --case runs a live model triage. Without it, no model requests are made.
 * Capture clean/ and shift/ separately, each with its own boxes.json.
 * Bounds use CSS document pixels; screenshots use twice that resolution.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CASE_IDX = argv.indexOf('--case');
const CASE_ID = CASE_IDX >= 0 ? argv[CASE_IDX + 1] : '';
const BOXES_IDX = argv.indexOf('--boxes');
const BOXES_OUT = BOXES_IDX >= 0 ? resolve(ROOT, argv[BOXES_IDX + 1] || 'shots/boxes.json') : '';
const positional = argv.filter(
  (a, i) =>
    a !== '--case' && a !== '--boxes' &&
    (CASE_IDX < 0 || i !== CASE_IDX + 1) &&
    (BOXES_IDX < 0 || i !== BOXES_IDX + 1),
);
const APP_URL = positional[0] || 'https://gpu-waste-auditor-2026.web.app';
const OUT_DIR = resolve(ROOT, positional[1] || 'shots');

// Measure bounds in the capture session. CSS document pixels are scaled by two when cropping.

const BOX_SELECTORS = {
  case: { verdict: '#verdict', evidence: '#evidence', tools: '#tools',
          actions: '#actions', aitext: '#aitext', pkg: '#export-pkg' },
  patrol: { kpis: '#cluster-kpis', nodes: '#nodes', events: '#events',
            tickets: '#tickets', notifications: '#notifications',
            patrolTools: '#patrol-tools' },
  bench: { benchTable: '#bench-tbl', benchRule: '#bench-rule', benchAi: '#bench-ai' },
  actions: { riskLevels: '#risk-levels', actionTable: '#action-tbl',
             discouraged: '#discouraged' },
};
const boxes = {};

async function dumpBoxes(tab) {
  if (!BOXES_OUT || !BOX_SELECTORS[tab]) return;
  boxes[tab] = await cdp.eval(`(() => {
    const sels = ${JSON.stringify(BOX_SELECTORS[tab])};
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
               w: Math.round(r.width), h: Math.round(r.height) };
    };
    const out = {};
    for (const [key, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) { out[key] = null; continue; }
      const panel = el.closest('.panel');
      out[key] = { sel, ...rect(el), panel: panel ? rect(panel) : null };
    }
    return out;
  })()`);

  if (tab === 'patrol') {
    boxes[tab].nodeRows = await cdp.eval(
      `[...document.querySelectorAll('#nodes .node')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
                 w: Math.round(r.width), h: Math.round(r.height) };
      })`,
    );
  }
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 400);

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  async waitFor(expression, { timeout = 25000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(expression, { awaitPromise: false });
        if (v) return v;
      } catch {}
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }

  async shot(file, { maxHeight = 12000 } = {}) {
    const m = await this.send('Page.getLayoutMetrics');
    const css = m.cssContentSize || m.contentSize;
    const width = Math.ceil(css.width);
    const full = Math.ceil(css.height);
    const height = Math.min(full, maxHeight);
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ✓ ${file.replace(`${ROOT}/`, '')} ${width}×${height}`);

    // Report truncated screenshots so missing content is visible in the CLI.
    if (full > height) {
      console.log(`    Warning: Page height ${full}px; maxHeight=${maxHeight} clipped ${full - height}px`);
    }
  }
}

const profile = mkdtempSync(join(tmpdir(), 'triage-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-gpu-sandbox',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function getWs() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const pages = list.filter((t) => t.type === 'page');
      const page = pages.find((t) => t.url === 'about:blank') || pages[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome debugging port unavailable. Last stderr:\n${chromeErr.slice(-800)}`);
}

mkdirSync(OUT_DIR, { recursive: true });

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});

console.log(`\nOpening ${APP_URL}\n`);
await cdp.send('Page.navigate', { url: APP_URL });
await cdp.waitFor(`document.querySelectorAll('#case-select option').length > 0`);
await new Promise((r) => setTimeout(r, 1200));

await cdp.eval(`document.querySelector('[data-tab="patrol"]').click()`);
await cdp.waitFor(`document.querySelectorAll('#nodes .node').length > 0`, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

await cdp.eval(`document.querySelector('[data-tab="bench"]').click()`);
await cdp.eval(`document.querySelector('#run-bench').click()`);
await cdp.waitFor(`/\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('#bench-rule').textContent)`);
await new Promise((r) => setTimeout(r, 600));

const ruleScore = await cdp.eval(`document.querySelector('#bench-rule').textContent.trim()`);
const clusterMeta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);
const eventsCount = await cdp.eval(`document.querySelector('#events-count').textContent.trim()`);

console.log('  Current readings:');
console.log(`    Benchmark rule baseline = ${ruleScore}`);
console.log(`    Cluster state = ${clusterMeta}`);
console.log(`    Operation log = ${eventsCount}`);

const shots = [
  ['patrol', 'live-02-patrol.png', 'On-call agent'],
  ['bench', 'live-03-benchmark.png', 'Benchmark'],
  ['actions', 'live-04-actions.png', 'Actions and approvals'],
];

const triageShot = ['case', 'live-01-triage.png', 'Case triage'];

if (CASE_ID) {
  console.log(`\nRunning live triage: ${CASE_ID} (uses model quota, about 5-6 requests)`);
  await cdp.eval(`document.querySelector('[data-tab="case"]').click()`);
  const picked = await cdp.eval(`(() => {
    const sel = document.querySelector('#case-select');
    const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(CASE_ID)});
    if (!opt) return null;
    // Set the value without firing change; #run-case starts triage below.
    sel.value = opt.value;
    return opt.textContent;
  })()`);
  if (!picked) throw new Error(`Case not found in selector: ${CASE_ID}`);
  console.log(`  Selected: ${picked}`);
  await cdp.eval(`document.querySelector('#run-case').click()`);

  const done = await cdp.waitFor(
    `document.querySelector('#case-result').style.display !== 'none'
      && document.querySelectorAll('#tools li').length > 0`,
    { timeout: 180000, interval: 1000 },
  );
  if (!done) throw new Error('Triage did not complete before timeout');

  const verdict = await cdp.eval(`document.querySelector('#verdict').innerText.trim().slice(0, 300)`);
  const toolCount = await cdp.eval(`document.querySelector('#toolcount').textContent.trim()`);
  const modeText = await cdp.eval(`document.querySelector('#verdict-mode').textContent.trim()`);
  console.log(`  Verdict mode: ${modeText}`);
  console.log(`  Tool trace: ${toolCount}`);
  console.log(`  Verdict excerpt: ${verdict.replace(/\n+/g, ' / ').slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 800));
}

console.log('\nScreenshots:');
for (const [tab, file, label] of [triageShot, ...shots]) {
  await cdp.eval(`document.querySelector('[data-tab="${tab}"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  console.log(`  · ${label}`);
  await cdp.shot(join(OUT_DIR, file));
  await dumpBoxes(tab);
}

if (BOXES_OUT) {
  writeFileSync(BOXES_OUT, `${JSON.stringify(boxes, null, 2)}\n`);
  const n = Object.values(boxes).reduce((a, t) => a + Object.keys(t || {}).length, 0);
  console.log(`\nBounds saved: ${BOXES_OUT.replace(`${ROOT}/`, '')}(${n} element bounds, CSS px)`);
}

console.log('\nDone.');
