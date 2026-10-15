#!/usr/bin/env node
/**
 * Record the demo as frames and a timeline for demo_caption.py.
 * Usage: node scripts/record_demo.mjs --mode=replay [--url=http://127.0.0.1:8908/] [--no-reset] [--dry]
 * Explicit local replay only. --dry skips model fixtures and patrol execution.
 * --no-reset skips resetting the isolated local replay state.
 * Outputs: <outDir>/frames/f000001.jpg and <outDir>/timeline.json.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayOptions, prepareReplay, showReplayDocument, RECORDING_MODE } from './demo_replay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
// Validate before Chrome, output creation, navigation, or any reset is possible.
const replay = replayOptions(argv);
const DRY = argv.includes('--dry');
const NO_RESET = argv.includes('--no-reset');
const OUT_DIR = resolve(ROOT, argv.find((a) => a.startsWith('--out='))?.slice(6) || 'shots-demo');
const APP_URL = replay.url;

const FRAMES = join(OUT_DIR, 'frames');
const TARGET_TOTAL = 165;   // Seconds; leave room below the 180-second submission limit.
const MIN_SCAN = 9;         // Minimum hold while patrol is running.
const FPS = 15;             // Capture rate below the observed screenshot throughput.

// Exclude the placeholder row when counting operation-log entries.
const REAL_EVENTS = '#events li.ok, #events li.fail, #events li.info';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 400);
const VW = 1600;
const VH = 900;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.queue = Promise.resolve();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method && this.handlers.has(msg.method)) this.handlers.get(msg.method)(msg.params);
    });
  }

  on(method, fn) { this.handlers.set(method, fn); }

  // Serialize screenshots and page evaluation to avoid stalled CDP commands.
  guard(method, params = {}) {
    const next = this.queue.then(() => this.send(method, params), () => this.send(method, params));
    this.queue = next.then(() => {}, () => {});
    return next;
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
      }, 15000);
    });
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.guard('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }

  async waitFor(expression, { timeout = 25000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression, { awaitPromise: false })) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep GPU rendering enabled for continuous frame capture.
const profile = mkdtempSync(join(tmpdir(), 'triage-rec-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });
let chromeDied = false;
chrome.on('exit', (code, sig) => {
  chromeDied = true;
  if (capturing) {
    console.log(`\nChrome exited (code=${code} sig=${sig}); recording interrupted. Last stderr:\n${chromeErr.slice(-1200)}\n`);
    process.exit(1);
  }
});

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function getWs() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter((t) => t.type === 'page');
      const page = pages.find((t) => t.url === 'about:blank') || pages[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Chrome debugging port unavailable. Last stderr:\n${chromeErr.slice(-800)}`);
}

// Poll captureScreenshot; headless screencast events are too sparse.

const frames = [];          // { file, t }
const slowPeeks = [];
let frameSeq = 0;
let t0 = 0;
let capturing = false;

async function captureLoop(cdp, fps) {
  const period = 1000 / fps;
  let lastBeat = Date.now();
  let lastN = 0;
  let consecutiveFail = 0;
  let lastFrameAt = Date.now();

  const watchdog = setInterval(() => {
    if (!capturing) return;
    if (Date.now() - lastFrameAt > 15000) {
      console.log('\nNo new frames for 15 seconds; stopping the stalled recording.');
      process.exit(1);
    }
  }, 3000);

  while (capturing) {
    const began = Date.now();
    const t = (began - t0) / 1000;
    try {
      const r = await cdp.guard('Page.captureScreenshot', {
        format: 'jpeg', quality: 80, captureBeyondViewport: false,
      });
      frameSeq += 1;
      consecutiveFail = 0;
      lastFrameAt = Date.now();
      const file = `f${String(frameSeq).padStart(6, '0')}.jpg`;
      writeFileSync(join(FRAMES, file), Buffer.from(r.data, 'base64'));
      frames.push({ file, t });

      const cost = Date.now() - began;
      if (cost > 900) slowPeeks.push({ t, cost });
    } catch {
      consecutiveFail += 1;
      if (consecutiveFail >= 8) {
        console.log(`\n${consecutiveFail} consecutive capture failures; stopping recording. Last stderr:\n${chromeErr.slice(-1200)}\n`);
        process.exit(1);
      }
    }
    if (Date.now() - lastBeat >= 5000) {
      console.log(`     · Capture ${((frameSeq - lastN) / ((Date.now() - lastBeat) / 1000)).toFixed(1)} fps (${frameSeq} total)`);
      lastBeat = Date.now();
      lastN = frameSeq;
    }
    const spent = Date.now() - began;
    if (spent < period) await sleep(period - spent);
  }
  clearInterval(watchdog);
}

const RING = '__demoRing';

async function clearRings(cdp) {
  await cdp.eval(`(() => {
    document.querySelectorAll('[data-demo-ring]').forEach((e) => {
      e.style.outline = ''; e.style.outlineOffset = ''; e.removeAttribute('data-demo-ring');
    });
  })()`);
}

async function ring(cdp, selectors) {
  await clearRings(cdp);
  return cdp.eval(`(() => {
    const list = ${JSON.stringify(Array.isArray(selectors) ? selectors : [selectors])};
    let n = 0;
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.style.outline = '3px solid #E5484D';
      el.style.outlineOffset = '3px';
      el.setAttribute('data-demo-ring', '1');
      n += 1;
    }
    return n;
  })()`);
}

async function ringByText(cdp, selector, texts) {
  await clearRings(cdp);
  return cdp.eval(`(() => {
    const list = ${JSON.stringify(Array.isArray(texts) ? texts : [texts])};
    let n = 0;
    for (const t of list) {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(t));
      if (!el) continue;
      el.style.outline = '3px solid #E5484D';
      el.style.outlineOffset = '3px';
      el.setAttribute('data-demo-ring', '1');
      n += 1;
    }
    return n;
  })()`);
}

async function scrollTo(cdp, selector, offset = 90, { instant = false } = {}) {
  return cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const y = Math.max(0, el.getBoundingClientRect().top + window.scrollY - ${offset});
    window.scrollTo({ top: y, behavior: ${instant ? "'auto'" : "'smooth'"} });
    return true;
  })()`);
}

async function click(cdp, selector) {
  return cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function scrollBy(cdp, px) {
  return cdp.eval(`window.scrollBy({ top: ${px}, behavior: 'smooth' }), true`);
}

async function timed(label, fn) {
  const began = Date.now();
  const at = (began - t0) / 1000;
  try {
    return await fn();
  } finally {
    const spent = (Date.now() - began) / 1000;
    console.log(`     · [${at.toFixed(1)}s] ${label} took ${spent.toFixed(1)}s`);
  }
}

/** Record step duration without pausing frame capture. */
// Click the tab button and verify that its panel becomes visible.
async function clickTab(cdp, name) {
  const ok = await cdp.eval(`(() => {
    const b = document.querySelector('#tabs button[data-tab=${JSON.stringify(name)}]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error(`Tab button not found: data-tab="${name}"`);
  const shown = await cdp.waitFor(`document.getElementById('tab-${name}') && !document.getElementById('tab-${name}').hidden`,
    { timeout: 5000, interval: 150 });
  if (!shown) throw new Error(`Clicked data-tab="${name}" but its panel is still hidden`);
}

async function mustWait(cdp, expr, what, timeout = 20000) {
  if (!(await cdp.waitFor(expr, { timeout }))) {
    throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
  }
}

const BEATS = [
  {
    id: 'intro-1',
    caption: 'Local deterministic replay: constructed cases and simulated nodes. No live model or production writes.',
    zh: '本地确定性回放：使用构造案例与模拟节点，不调用在线模型，不写入生产环境。',
    voice: 'This local replay uses constructed cases and simulated nodes. It makes no live model calls or production writes.',
    hold: 7,
    run: async (cdp) => {
      await clickTab(cdp, 'case');
      if (DRY) return scrollTo(cdp, '#case-select', 90, { instant: true });
      await cdp.eval(`(() => { const s = document.querySelector('#case-select'); s.value = 'case-xid94-rising'; s.dispatchEvent(new Event('change')); })()`);
      await mustWait(cdp, `document.querySelector('#tab-case[data-state="complete"]')`, 'Case replay complete', 60000);
      await scrollTo(cdp, '#case-select', 90, { instant: true });
    },
  },
  {
    id: 'intro-2',
    caption: 'Case triage combines a classification, an RMA recommendation, evidence citations, and an action plan.',
    zh: '案例分诊给出故障分类、RMA 建议、证据引用与行动计划。',
    voice: 'Case triage gives a classification, an RMA recommendation, evidence citations, and an action plan.',
    hold: 7,
    run: async (cdp) => { await scrollTo(cdp, '#tools', 100); await ring(cdp, ['#tools']); },
  },
  {
    id: 'live',
    caption: 'On-call patrol reads six simulated nodes. This recording replays Firestore responses locally.',
    zh: '值班巡检读取六个模拟节点。本次录制在本地回放 Firestore 响应。',
    voice: 'On-call patrol reads six simulated nodes. This recording replays the Firestore responses locally.',
    hold: 8,
    run: async (cdp) => {
      await clearRings(cdp);
      await clickTab(cdp, 'patrol');

      await mustWait(cdp, `!document.getElementById('tab-patrol').hidden`, 'Patrol panel visible', 5000);
      await scrollTo(cdp, '#cluster-meta');
      await sleep(1400);
      await ring(cdp, ['#cluster-meta']);
    },
  },
  {
    id: 'start',
    caption: 'Run patrol starts the workflow. This static browser app has no resident monitoring process.',
    zh: '点击 Run patrol 启动流程。静态浏览器应用没有常驻监控进程。',
    voice: 'Run patrol starts the workflow. This static browser app has no resident monitoring process.',
    hold: 6,
    run: async (cdp) => {
      await scrollTo(cdp, '#run-patrol');
      await sleep(1200);
      await ring(cdp, ['#run-patrol']);
      await sleep(900);
      await clearRings(cdp);
      if (DRY) console.log('  · dry: patrol click skipped (no model requests)');
      else await click(cdp, '#run-patrol');
    },
  },
  {
    id: 'scan',
    // Fill {calls} from the observed tool count after patrol finishes.

    caption: 'The replay drives the actual tools. This patrol made {calls} tool calls, counted from the UI.',
    zh: '回放驱动真实工具代码。本次巡检有 {calls} 次工具调用，数量取自界面。',
    voice: 'The replay drives the actual tools. This patrol made {calls} tool calls, counted from the interface.',
    hold: MIN_SCAN,
    waitDone: true,
    run: async (cdp) => {
      await sleep(2600);
      await scrollTo(cdp, '#patrol-tools');
    },
  },
  {
    id: 'trace',
    caption: 'scan_cluster and inspect_node return node evidence. Case mode exposes 6 tools; patrol exposes all 10.',
    zh: 'scan_cluster 与 inspect_node 返回节点证据。案例模式有 6 个工具，巡检模式有 10 个。',
    voice: 'Scan cluster and inspect node return node evidence. Case mode has six tools; patrol has all ten.',
    hold: 10,
    run: async (cdp) => { await ring(cdp, ['#patrol-tools']); await scrollTo(cdp, '#patrol-tools'); },
  },
  {
    id: 'pair-1',
    caption: 'Two nodes, the same fault code: Xid 94.',
    zh: '两个节点，报的是同一个故障码：Xid 94。',
    voice: 'These two nodes reported the same fault code, Xid 94.',
    hold: 6,
    run: async (cdp) => {
      await clearRings(cdp);
      await scrollTo(cdp, '#nodes', 120);
      await sleep(1300);
      await ringByText(cdp, '#nodes .node', ['lyg2103', 'lyg2112']);
    },
  },
  {
    id: 'pair-2',
    caption: 'lyg2103: one occurrence in 30 days, correctable ECC flat. Verdict hardware_watch, so no RMA.',
    zh: 'lyg2103：30 天只出现 1 次，可纠正 ECC 平稳。判定 hardware_watch，不报修。',
    voice: 'lyg2103 fired once in thirty days, and its correctable ECC is flat. Verdict hardware watch. No RMA.',
    hold: 8,
    run: async (cdp) => { await ringByText(cdp, '#nodes .node', 'lyg2103'); },
  },
  {
    id: 'pair-3',
    caption: 'lyg2112: 53 occurrences in 30 days, correctable ECC at 118 and rising. Recommend hardware escalation.',
    zh: 'lyg2112：30 天累计 53 次，可纠正 ECC 已到 118 且仍在上升。建议报修。',
    voice: 'lyg2112 fired 53 times in thirty days. Correctable ECC is at 118 and rising. Recommend hardware escalation.',
    hold: 8,
    run: async (cdp) => { await ringByText(cdp, '#nodes .node', 'lyg2112'); },
  },
  {
    id: 'pair-4',
    caption: 'The same Xid can require different responses. The history and telemetry support the decision.',
    zh: '同一个 Xid 可能需要不同处置。历史记录与遥测共同支持判断。',
    voice: 'The same Xid can need different responses. History and telemetry support the decision.',
    hold: 6,
    run: async (cdp) => { await clearRings(cdp); },
  },
  {
    id: 'oplog',
    caption: 'Two local simulated cordons block new jobs while running jobs continue. Both appear in the operation log.',
    zh: '两次本地模拟 cordon 阻止新任务进入，现有任务继续运行。操作日志记录了两次处置。',
    voice: 'Two local simulated cordons block new jobs while running jobs continue. Both appear in the operation log.',
    hold: 9,
    run: async (cdp) => { await scrollTo(cdp, '#events', 110); await sleep(1200); await ring(cdp, ['#events']); },
  },
  {
    id: 'verify',
    caption: 'Verification checks the returned simulated state. Here, all storage responses come from the local replay.',
    zh: '验证检查返回的模拟状态。本次所有存储响应均来自本地回放。',
    voice: 'Verification checks the returned simulated state. Here, every storage response comes from the local replay.',
    hold: 8,
    run: async (cdp) => { await ring(cdp, ['#events']); },
  },
  {
    id: 'raw',
    caption: 'Raw simulated node state uses the Firestore REST document format. This is a local replay response.',
    zh: '模拟节点原始状态使用 Firestore REST 文档格式。这是本地回放响应。',
    voice: 'Raw simulated node state uses the Firestore REST document format. This is a local replay response.',
    hold: 8,
    run: async (cdp) => {
      await clearRings(cdp);
      await timed('Show local replay Firestore document', async () => {
        await showReplayDocument(cdp);
        await mustWait(cdp, `location.pathname === '/__replay__/cluster' && document.querySelector('pre')?.textContent.includes('local_deterministic_replay')`,
          'Local replay JSON body rendered', 15000);
      });
      await sleep(500);
      await cdp.eval(`(() => {
        const t = document.body.innerText;
        const i = t.indexOf('lyg2112');
        window.scrollTo({ top: Math.max(0, (i / t.length) * document.body.scrollHeight - 260), behavior: 'auto' });
      })()`);
    },
  },
  {
    id: 'back',
    caption: 'The local replay state survives a page reload. lyg2112 remains cordoned.',
    zh: '本地回放状态在页面重载后保留。lyg2112 仍为 cordoned。',
    voice: 'The local replay state survives a page reload. lyg2112 remains cordoned.',
    hold: 7,
    run: async (cdp) => {
      await timed('Reload the app', async () => {
        await cdp.guard('Page.navigate', { url: APP_URL });
        await mustWait(cdp, `document.querySelectorAll('#case-select option').length > 0`, 'App remounted');
        await clickTab(cdp, 'patrol');

        await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, 'Node cards rendered');
      });
      await sleep(1800);
      await scrollTo(cdp, '#events', 110);
    },
  },
  {
    id: 'ticket',
    caption: 'The RMA ticket is a draft for human review. No repair request has been submitted.',
    zh: 'RMA 工单只是待人工审核的草稿，没有提交报修请求。',
    voice: 'The RMA ticket is a draft for human review. No repair request has been submitted.',
    hold: 9,
    run: async (cdp) => { await scrollTo(cdp, '#tickets', 110); await sleep(1200); await ring(cdp, ['#tickets']); },
  },
  {
    id: 'notify',
    caption: 'Notifications remain queued. This build has no IM or email delivery integration.',
    zh: '通知保留为 queued 队列状态。本版本没有接入 IM 或邮件投递。',
    voice: 'Notifications remain queued. This build has no IM or email delivery integration.',
    hold: 8,
    run: async (cdp) => { await scrollTo(cdp, '#notifications', 110); await sleep(1000); await ring(cdp, ['#notifications']); },
  },
  {
    id: 'approvals',
    caption: 'The catalog assigns risk: 6 low, 5 medium, 3 high. Medium and high risk require human approval.',
    zh: '目录定义风险：6 个低风险、5 个中风险、3 个高风险。中高风险必须由人工审批。',
    voice: 'The catalog assigns risk: six low, five medium, three high. Medium and high risk require human approval.',
    hold: 9,
    run: async (cdp) => {
      await clearRings(cdp);
      await clickTab(cdp, 'actions');
      await scrollTo(cdp, '#risk-levels', 100);
      await ring(cdp, ['#risk-levels']);
    },
  },
  {
    id: 'bench-1',
    caption: 'On 14 constructed cases, the F8 rule baseline gets classification and RMA jointly correct on 11/14.',
    zh: '在 14 个构造案例中，F8 规则基线的分类与 RMA 联合正确率为 11/14。',
    voice: 'On fourteen constructed cases, the F8 rule baseline gets classification and the RMA decision jointly correct on eleven.',
    hold: 8,
    run: async (cdp) => {
      await clearRings(cdp);
      await clickTab(cdp, 'bench');
      await sleep(900);
      await click(cdp, '#run-bench');
      await mustWait(cdp,
        `/\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('#bench-rule').textContent)`,
        'Rule benchmark score displayed (for example 11 / 14)');
      await sleep(700);
      await scrollTo(cdp, '#bench-rule');
      await ring(cdp, ['#bench-rule']);
    },
  },
  {
    id: 'bench-2',
    caption: 'The three misses involve a secondary event, a rising error trend, and a code deadlock. This is not production accuracy.',
    zh: '三个失误涉及次生事件、错误上升趋势与代码死锁。该分数不代表生产准确率。',
    voice: 'The three misses involve a secondary event, a rising error trend, and a code deadlock. This is not production accuracy.',
    hold: 9,
    run: async (cdp) => { await scrollTo(cdp, '#bench-tbl', 130); await sleep(1000); await ring(cdp, ['#bench-tbl']); },
  },
  {
    id: 'bench-3',
    caption: 'Run rule baseline is local and reproducible. This replay does not claim an aggregate AI score.',
    zh: 'Run rule baseline 可在本地复现。本次回放不宣称汇总 AI 得分。',
    voice: 'The rule baseline is local and reproducible. This replay does not claim an aggregate AI score.',
    hold: 6,
    run: async (cdp) => { await clearRings(cdp); },
  },
  {
    id: 'end',
    caption: 'REA is not included in this build. Production use needs telemetry, scheduler integration, access controls, and review.',
    zh: '本版本不包含 REA。生产应用还需要遥测、调度集成、访问控制与人工审核。',
    voice: 'REA is not included in this build. Production use needs telemetry, scheduler integration, access controls, and human review.',
    hold: 7,
    run: async (cdp) => { await cdp.eval(`window.scrollTo({ top: 0, behavior: 'smooth' })`); },
  },
];

/** Fill the observed tool count; dry runs use N because no patrol was measured. */
function fillCalls(n) {
  for (const b of BEATS) {
    for (const k of ['caption', 'zh', 'voice']) {
      if (b[k]) b[k] = b[k].split('{calls}').join(String(n));
    }
  }
}

// Export text from BEATS without resetting the cluster or recording.

//   node scripts/record_demo.mjs --mode=replay --dump-beats --calls=17
// Export text without resetting the cluster or recording.
if (argv.includes('--dump-beats')) {
  const calls = argv.find((a) => a.startsWith('--calls='))?.slice(8);
  if (calls) fillCalls(calls);
  const left = BEATS.filter((b) => (b.caption || '').includes('{calls}'));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'beats.json'), JSON.stringify({
    note: 'Generated by record_demo.mjs --dump-beats; BEATS supplies English subtitles, Chinese subtitles, and narration',
    calls: calls || null,
    recordingMode: RECORDING_MODE,
    beats: BEATS.map((b) => ({ id: b.id, caption: b.caption, zh: b.zh, voice: b.voice, hold: b.hold })),
  }, null, 1));
  console.log(`Exported ${BEATS.length} beats to ${OUT_DIR}/beats.json`);
  if (left.length) console.log(`Unfilled {calls} in beats: ${left.map((b) => b.id).join(', ')} (add --calls=N)`);
  process.exit(left.length ? 1 : 0);
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

let ws;
try {
ws = new WebSocket(await getWs());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const auditReplay = await prepareReplay(cdp, APP_URL);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
});

console.log(`\nOpening ${APP_URL}\n`);
await cdp.guard('Page.navigate', { url: APP_URL });
await mustWait(cdp, `document.querySelectorAll('#case-select option').length > 0`, 'App mounted');
await sleep(1500);

// Select the tab button, then wait for node cards to render.

await clickTab(cdp, 'patrol');
await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, 'Node cards rendered');
await sleep(1200);

if (!NO_RESET) {
  console.log('Resetting the simulated cluster before recording (6 nodes, 4 alerts)...');
  await click(cdp, '#reset-cluster');
  await mustWait(cdp, `document.querySelector('#cluster-status[data-state="reset"]')`, 'Reset and readback complete');
  // Count only classified event rows; the empty-state placeholder is not an event.

  await mustWait(cdp, `document.querySelectorAll('${REAL_EVENTS}').length === 0`, 'Operation log cleared');
  await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, 'Node cards rendered after reset');
  await sleep(1500);
}

const meta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);

const events0 = await cdp.eval(`document.querySelectorAll('${REAL_EVENTS}').length`);
console.log(`Cluster readings: ${meta}`);
console.log(`Operation log: ${events0} entries`);

const facing = await cdp.eval(`(() => {
  const vis = [...document.querySelectorAll('.tab')].filter((t) => !t.hidden).map((t) => t.id);
  return { visible: vis, tabOn: document.querySelector('#tabs button.on')?.textContent || '' };
})()`);
const facingOk = facing.visible.length === 1 && facing.visible[0] === 'tab-patrol';
console.log(`Visible panel: ${facing.visible.join(',') || '(none)'}; active tab: ${facing.tabOn}`);
if (!facingOk) throw new Error(`Unexpected panel before recording: ${facing.visible.join(',')}; expected only tab-patrol`);
console.log('Recording started\n');

t0 = Date.now();
capturing = true;
const captureTask = captureLoop(cdp, FPS);
await sleep(120);

const timeline = { app: APP_URL, recordingMode: RECORDING_MODE, fps: FPS, vw: VW, vh: VH, dry: DRY, beats: [] };
const now = () => (Date.now() - t0) / 1000;

if (DRY) fillCalls('N');

let scale = 1;
for (let i = 0; i < BEATS.length; i += 1) {
  const b = BEATS[i];
  const start = now();
  console.log(`[${start.toFixed(1)}s] ${b.id}`);

  try { if (b.run) await b.run(cdp); } catch (e) { console.log(`  ! Step failed: ${e.message}`); }

  if (b.waitDone && !DRY) {
    const ok = await cdp.waitFor(`document.querySelector('#tab-patrol[data-state="complete"], #tab-patrol[data-state="failed"]')`,
      { timeout: 240000, interval: 600 });
    if (!ok) console.log('  ! Patrol did not finish within 240s; continuing with the current view');

    const settled = await cdp.waitFor(`document.querySelectorAll('${REAL_EVENTS}').length > 0`,
      { timeout: 8000, interval: 300 });
    console.log(settled ? '  · Operation log persisted and rendered' : '  · Timed out waiting for the operation log (this patrol may have executed no actions)');

    const n = await cdp.eval(`(document.querySelector('#patrol-toolcount').textContent.match(/(\\d+)/) || [])[1]`);
    if (n) {
      console.log(`  · Subtitle tool count read from the page: ${n}`);
    } else {
      console.log('  ! Tool count unavailable; subtitle placeholder retained. Do not publish this recording.');
    }
    fillCalls(n || 'N');
  }

  const elapsed = now() - start;
  const want = b.waitDone ? Math.max(b.hold, elapsed) : b.hold * scale;
  if (want > elapsed) await sleep((want - elapsed) * 1000);

  const end = now();
  // Preserve both subtitle languages in the timeline.

  timeline.beats.push({ id: b.id, caption: b.caption, zh: b.zh, t0: start, t1: end });

  // Scale remaining holds to the recording budget, keeping each at least half its original duration.
  if (b.waitDone) {
    const left = BEATS.slice(i + 1).reduce((s, x) => s + x.hold, 0);
    const budget = TARGET_TOTAL - end;

    scale = Math.max(0.5, Math.min(1, budget / left));
    const projected = end + left * scale;
    console.log(`  · Elapsed ${end.toFixed(1)}s; remaining holds scaled by ${scale.toFixed(2)}; projected duration ${projected.toFixed(0)}s`);
    if (projected > 178) {
      console.log(`  ! Projected duration ${projected.toFixed(0)}s approaches the 180s limit; consider recording again.`);
    }
  }
}

await sleep(700);
capturing = false;
await captureTask;

const unfilled = BEATS.filter((b) => (b.caption || '').includes('{calls}') || (b.zh || '').includes('{calls}'));
if (unfilled.length) {
  throw new Error(`Unfilled {calls} in subtitles:${unfilled.map((b) => b.id).join(', ')}`);
}

timeline.duration = now();
timeline.frameCount = frames.length;
await auditReplay(join(OUT_DIR, 'replay-audit.json'));
writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify({ ...timeline, frames }, null, 1));

const patrolStatus = await cdp.eval(`document.querySelector('#patrol-status').textContent.trim()`).catch(() => '');
const eventsN = await cdp.eval(`document.querySelectorAll('${REAL_EVENTS}').length`).catch(() => -1);

console.log('\nRecording finished');
console.log(`  Duration  =${timeline.duration.toFixed(1)}s`);
console.log(`  Frames    = ${frames.length} (average ${(frames.length / timeline.duration).toFixed(1)} fps)`);
console.log(`  Patrol    =${patrolStatus}`);
console.log(`  Log entries = ${events0} -> ${eventsN}`);

if (slowPeeks.length) {
  const worst = slowPeeks.reduce((a, b) => (b.cost > a.cost ? b : a));
  const total = slowPeeks.reduce((s, x) => s + x.cost, 0) / 1000;
  console.log(`  Slow captures = ${slowPeeks.length} over 900ms; total ${total.toFixed(1)}s; worst ${worst.cost}ms @ ${worst.t.toFixed(1)}s`);
} else {
  console.log('  Slow captures = none (all under 900ms)');
}
console.log(`  Output    =${OUT_DIR}/frames/  +  timeline.json\n`);
if (!frames.length) console.log('No frames recorded; check captureScreenshot support');
} finally {
  // Normal completion must release the resources that otherwise prevent exit.
  capturing = false;
  try { ws?.close(); } finally { cleanup(); }
}
