#!/usr/bin/env node
/**
 * 演示视频录屏：把线上站点按 `docs/demo-script.md` 的分镜**真的走一遍**，录成逐帧序列。
 *
 * 为什么不用 mac 的录屏工具：这里要的不是「有人手动操作」的画面，而是**可复现的录制**——
 * 分镜改了可以重录，每次的节奏一致，而且录完能拿到一份 timeline.json，
 * 说明每一句字幕对应哪一段真实时间。字幕由 `demo_caption.py` 烧进去，
 * 不做剪辑拼接，避免「画面与口播对不上」。
 *
 * ★ 会消耗模型配额：值班巡检没有缓存，一次约 12–16 次模型请求。
 *   单次分诊那一段**不录**（它要预热缓存才有意义），基准页点的是「跑规则基线」，本地秒出、零请求。
 *
 * 用法：
 *   node scripts/record_demo.mjs                  # 录到 shots-demo/
 *   node scripts/record_demo.mjs --no-reset       # 不重置集群（默认会先重置，保证 6 节点 / 4 异常）
 *   node scripts/record_demo.mjs --dry            # 不真跑巡检，只走画面（用于试运行，零配额）
 *
 * 产物：<outDir>/frames/f000001.jpg … 与 <outDir>/timeline.json
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NO_RESET = argv.includes('--no-reset');
const OUT_DIR = resolve(ROOT, argv.find((a) => a.startsWith('--out='))?.slice(6) || 'shots-demo');
const APP_URL = argv.find((a) => a.startsWith('--url='))?.slice(6) || 'https://gpu-waste-auditor-2026.web.app';

const FRAMES = join(OUT_DIR, 'frames');
const TARGET_TOTAL = 165;   // 秒。官方上限 180，留 15 秒余量
const MIN_SCAN = 9;         // 巡检那一段至少停这么久，否则看不出「在跑」
const FPS = 15;             // 抓帧帧率。实测 captureScreenshot 上限 ~25 fps，留一半余量

// 只数「真实事件」的选择器。`renderEvents()` 零事件时会渲染一条占位 li
// （`暂无操作记录`），所以 `#events li` 的数量永远 >= 1，不能拿它当计数器。
const REAL_EVENTS = '#events li.ok, #events li.fail, #events li.info';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 400);
const VW = 1600;
const VH = 900;

// ---------------------------------------------------------------- CDP 客户端
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

  /**
   * 串行闸：抓帧与页面求值**不允许重叠**。
   *
   * 实测过：单独跑抓帧循环 150s 零失败；一旦让 captureScreenshot 与
   * Runtime.evaluate 真并发，几十秒后整条 CDP 静默停住（不报错、不退出、不再出新帧）。
   * 所有命令都从这里过一遍，代价是抓帧率从 25 掉到 15 —— 而 15 fps 对录屏足够。
   */
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
      } catch { /* 页面还没就绪 */ }
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 启动 Chrome
//
// ★ 这一组参数是**实测选出来的**，不要随手加：
//   `--disable-gpu --disable-gpu-sandbox --disable-software-rasterizer` 这组
//   在截图脚本里能用（它只拍几张），但**连续抓帧时会几千次把 GPU 进程逼崩** ——
//   现象是 WebSocket 连同抓帧循环一起静默停住，日志没有报错，只是不再有新帧。
//   去掉这三个之后，同一台机器上连续 25 fps 抓了 24 秒无异常。
//   `--no-sandbox` 仍然不可省（嵌套沙箱会让 GPU 进程初始化失败，理由见 capture_shots.mjs）。
const profile = mkdtempSync(join(tmpdir(), 'triage-rec-'));
const chrome = spawn(CHROME, [
  '--headless=new',
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
    console.log(`\n★ Chrome 退出了（code=${code} sig=${sig}），录制中断。stderr 尾部：\n${chromeErr.slice(-1200)}\n`);
    process.exit(1);
  }
});

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
    } catch { /* Chrome 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`Chrome 调试端口没起来。stderr 尾部：\n${chromeErr.slice(-800)}`);
}

// ---------------------------------------------------------------- 录屏帧
//
// ★ 为什么不用 `Page.startScreencast`：实测在 headless Chrome 里它 0.1 fps
//   （7 秒只出 1 帧）—— 它只在合成器「有 damage」时才推帧，headless 下几乎不推。
//   `Page.captureScreenshot` 同一台机器上能跑 ~25 fps，所以改成**轮询抓帧**。
//   实测结论：screencast 不可用，captureScreenshot 可用，两者差 250 倍。
// ★ 抓帧与驱动必须互斥。
//   实测：单独跑抓帧循环 150 秒零失败（14.9 fps），但一旦让「抓帧循环」与
//   「页面操作（Runtime.evaluate）」真并发，跑几十秒后 WebSocket 会**静默停住** ——
//   没有报错、没有退出、也没有新帧，只是两边都不再回包。判断是 headless 下
//   screenshot 与 evaluate 在同一渲染主线程上互相等。改成互斥后两边都稳。
const frames = [];          // { file, t }
const slowPeeks = [];       // 抓帧耗时 > 900ms 的时刻（页面在重活，可能变成冻帧）
let frameSeq = 0;
let t0 = 0;                 // 时间轴零点（毫秒）
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
      console.log('\n★ 15 秒没有任何新帧，判定链路已卡死，中止录制（避免录出一段冻住的画面）。');
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
      // 单次抓帧突然变慢 = 页面在做重活（重载 / 导航）。记下来，别让它变成成片里的长冻帧。
      const cost = Date.now() - began;
      if (cost > 900) slowPeeks.push({ t, cost });
    } catch {
      consecutiveFail += 1;
      if (consecutiveFail >= 8) {
        console.log(`\n★ 连续 ${consecutiveFail} 次抓帧失败，中止录制。stderr 尾部：\n${chromeErr.slice(-1200)}\n`);
        process.exit(1);
      }
    }
    if (Date.now() - lastBeat >= 5000) {
      console.log(`     · 抓帧 ${((frameSeq - lastN) / ((Date.now() - lastBeat) / 1000)).toFixed(1)} fps（累计 ${frameSeq}）`);
      lastBeat = Date.now();
      lastN = frameSeq;
    }
    const spent = Date.now() - began;
    if (spent < period) await sleep(period - spent);
  }
  clearInterval(watchdog);
}

// ---------------------------------------------------------------- 页面操作
const RING = '__demoRing';

async function clearRings(cdp) {
  await cdp.eval(`(() => {
    document.querySelectorAll('[data-demo-ring]').forEach((e) => {
      e.style.outline = ''; e.style.outlineOffset = ''; e.removeAttribute('data-demo-ring');
    });
  })()`);
}

/** 给元素加一圈高亮描边 —— 这是演示annotation，用来替代录屏里看不见的鼠标指针。 */
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

/** 按元素内文定位并加环 —— 比 nth-child 稳，节点卡片的顺序不该被版式改动绑住。 */
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

/** 只计时、不暂停抓帧。给「页面在做重活」的步骤留一条可核查的耗时记录。 */
async function timed(label, fn) {
  const began = Date.now();
  const at = (began - t0) / 1000;
  try {
    return await fn();
  } finally {
    const spent = (Date.now() - began) / 1000;
    console.log(`     · [${at.toFixed(1)}s] ${label} 占用 ${spent.toFixed(1)}s`);
  }
}

/**
 * 切换标签页。★ 必须点 `#tabs` 里的 `button[data-tab=...]`。
 *
 * 这里踩过一个代价很大的坑：`#tab-patrol` 是**面板 div**（`index.html:87`），
 * 不是标签按钮；点它不会触发任何切换（`app.js:89` 的监听挂在 `#tabs` 上）。
 * 更糟的是当时那句 `waitFor` 的返回值被丢掉了，于是既不报错也不切换，
 * 只是安静地空转 30 秒 —— 录完整场才发现画面一直停在「单次分诊」页。
 * 所以这里点击之后**断言面板真的显示了**，不信 `click()` 的返回值。
 */
async function clickTab(cdp, name) {
  const ok = await cdp.eval(`(() => {
    const b = document.querySelector('#tabs button[data-tab=${JSON.stringify(name)}]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到标签按钮 data-tab="${name}"`);
  const shown = await cdp.waitFor(`document.getElementById('tab-${name}') && !document.getElementById('tab-${name}').hidden`,
    { timeout: 5000, interval: 150 });
  if (!shown) throw new Error(`点了 data-tab="${name}"，但对应面板仍然隐藏 —— 切换没生效`);
}

/** 等待必须等到：超时就抛错。★ 绝不允许把 waitFor 的返回值悄悄丢掉。 */
async function mustWait(cdp, expr, what, timeout = 20000) {
  if (!(await cdp.waitFor(expr, { timeout }))) {
    throw new Error(`${timeout}ms 内没等到「${what}」`);
  }
}

// ---------------------------------------------------------------- 分镜
/**
 * 每一拍：caption = 字幕；hold = 目标停留秒数；run = 该拍的动作。
 * 第 5 拍（巡检等待）是**事件驱动**的：等 #patrol-status 出现「完成」，
 * 并保证至少停 MIN_SCAN 秒 —— 这两件事谁晚就以谁为准。
 * 之后所有拍的 hold 会按剩余预算整体缩放，保证成片不超时。
 */
const BEATS = [
  {
    id: 'intro-1',
    caption: 'Multi-cloud GPU training clusters, run by a small on-call team.',
    zh: '多云的 GPU 训练集群，靠一支小规模值班团队撑着。',
    voice: 'We run GPU training clusters across several clouds, with a small on-call team.',
    hold: 7,
    run: async (cdp) => { await scrollTo(cdp, '#tabs', 90, { instant: true }); },
  },
  {
    id: 'intro-2',
    caption: 'The costly mistakes are direction errors. A software bug gets treated as failing hardware.',
    zh: '贵的误判是方向错：软件的问题，当成硬件坏了。',
    voice: 'The costly mistakes are direction errors. A software bug gets read as broken hardware.',
    hold: 7,
    run: async (cdp) => { await ring(cdp, ['#patrol-mode']); },
  },
  {
    id: 'live',
    caption: 'On-call mode. Nobody pastes a log here; the cluster state is read live from Cloud Firestore.',
    zh: '值班模式。这里没有人贴日志，集群状态从 Cloud Firestore 实时读出来。',
    voice: 'This is on-call mode. Nobody pastes a log. The cluster state is read live from Cloud Firestore.',
    hold: 11,
    run: async (cdp) => {
      await clearRings(cdp);
      // 标签在巡检之前就已经切好了（录前准备里切过），这里只是再确认一次面板可见
      await mustWait(cdp, `!document.getElementById('tab-patrol').hidden`, '值班面板可见', 5000);
      await scrollTo(cdp, '#cluster-meta');
      await sleep(1400);
      await ring(cdp, ['#cluster-meta']);
    },
  },
  {
    id: 'start',
    caption: 'One click starts the shift. In production a scheduler triggers it; a static site has no resident process.',
    zh: '点一下开始值班。真实部署里由调度器定时触发；纯静态站点没有常驻进程。',
    voice: 'One click starts it. In production a scheduler triggers this. A static site has no resident process.',
    hold: 7,
    run: async (cdp) => {
      await scrollTo(cdp, '#run-patrol');
      await sleep(1200);
      await ring(cdp, ['#run-patrol']);
      await sleep(900);
      await clearRings(cdp);
      if (DRY) console.log('  · dry：跳过点击巡检（零配额）');
      else await click(cdp, '#run-patrol');
    },
  },
  {
    id: 'scan',
    // ★ `{calls}` 是占位符，不是最终文案：巡检跑完后会用**画面上真实显示的次数**回填
    //   （读 `#patrol-toolcount`）。字幕里写死一个数字，一旦这次巡检的调用次数不同，
    //   字幕就和画面打架了 —— 那正是「看起来比实际更可信」的典型。
    caption: 'It scans the cluster itself, then inspects each node. This shift took {calls} tool calls, all on screen.',
    zh: '它自己扫集群、逐个节点取证。这次值班用了 {calls} 次工具调用，全部在屏幕上。',
    voice: 'It scans the cluster, then inspects each node. This shift took {calls} tool calls, and every one is on screen.',
    hold: MIN_SCAN,
    waitDone: true,
    run: async (cdp) => {
      await sleep(2600);
      await scrollTo(cdp, '#patrol-tools');
    },
  },
  {
    id: 'trace',
    caption: 'scan_cluster and inspect_node supply every number the model may use. It does no arithmetic of its own.',
    zh: '模型能用的每个数字都由 scan_cluster 与 inspect_node 提供；它自己不做算术。',
    voice: 'Every number the model may use comes from scan_cluster or inspect_node. It does no arithmetic of its own.',
    hold: 17,
    run: async (cdp) => { await ring(cdp, ['#patrol-tools']); await scrollTo(cdp, '#patrol-tools'); },
  },
  {
    id: 'pair-1',
    caption: 'Two nodes, the same fault code: Xid 94.',
    zh: '两个节点，报的是同一个故障码：Xid 94。',
    voice: 'These two nodes reported the same fault code, Xid 94.',
    hold: 8,
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
    hold: 9,
    run: async (cdp) => { await ringByText(cdp, '#nodes .node', 'lyg2103'); },
  },
  {
    id: 'pair-3',
    caption: 'lyg2112: 53 occurrences in 30 days, correctable ECC at 118 and still rising. File the RMA.',
    zh: 'lyg2112：30 天累计 53 次，可纠正 ECC 已到 118 且仍在上升。建议报修。',
    voice: 'lyg2112 fired 53 times. Correctable ECC is at 118 and still climbing. File the RMA.',
    hold: 9,
    run: async (cdp) => { await ringByText(cdp, '#nodes .node', 'lyg2112'); },
  },
  {
    id: 'pair-4',
    caption: 'The decision came from the trend, not from the code.',
    zh: '判断依据是趋势，不是那个码本身。',
    voice: 'The decision came from the trend, not from the code.',
    hold: 6,
    run: async (cdp) => { await clearRings(cdp); },
  },
  {
    id: 'oplog',
    caption: 'It acted. It cordoned two nodes, and both writes are in the operation log.',
    zh: '它动手了：cordon 了两个节点，两条写入都在操作日志里。',
    voice: 'It acted. It cordoned two nodes, and both writes are in the operation log.',
    hold: 11,
    run: async (cdp) => { await scrollTo(cdp, '#events', 110); await sleep(1200); await ring(cdp, ['#events']); },
  },
  {
    id: 'verify',
    caption: 'After each write the app re-reads the value from the server. That is what "verification passed" means here.',
    zh: '每次写完之后，它会重新读服务端的值。这就是「回验通过」的含义。',
    voice: 'After every write, the app re-reads the value from the server. That is what verification passed means here.',
    hold: 10,
    run: async (cdp) => { await ring(cdp, ['#events']); },
  },
  {
    id: 'raw',
    caption: 'The same value, read straight from the Firestore REST API instead of our own interface.',
    zh: '同一个值，直接取自 Firestore REST API，而不是我们自己的界面。',
    voice: 'Same value, read straight from the Firestore REST API, not from our own interface.',
    hold: 11,
    run: async (cdp) => {
      await clearRings(cdp);
      await timed('切到 Firestore REST 原始响应', async () => {
        const url = await cdp.eval(`import('/js/cluster.js').then((m) =>
          'https://firestore.googleapis.com/v1/projects/' + m.CLUSTER_META.projectId +
          '/databases/(default)/documents/cluster?key=' + m.CLUSTER_META.apiKey)`);
        await cdp.guard('Page.navigate', { url });
        // ★ 等待条件必须**只有新页面能满足**。
        //   之前写成 `body.innerText.includes('lyg2112')`，结果导航刚发出、旧的应用页
        //   正文里本来就有 lyg2112，条件立刻为真（实测 0.2s 就返回），于是滚动定位
        //   滚的是旧页面 —— 看起来一切正常，实际拍错了对象。
        await mustWait(cdp, `location.href.includes('firestore.googleapis.com')`,
          'URL 变成 firestore.googleapis.com', 15000);
        await mustWait(cdp, `document.body.innerText.trim().startsWith('{')`,
          'Firestore 的 JSON 正文渲染出来', 15000);
        return url;
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
    caption: 'After a full page reload the state is the same. lyg2112 is still cordoned.',
    zh: '整页重载之后状态一致，lyg2112 仍然是 cordoned。',
    voice: 'After a full page reload the state is the same. lyg2112 is still cordoned.',
    hold: 9,
    run: async (cdp) => {
      await timed('整页重载回应用', async () => {
        await cdp.guard('Page.navigate', { url: APP_URL });
        await mustWait(cdp, `document.querySelectorAll('#case-select option').length > 0`, '应用重新挂载完成');
        await clickTab(cdp, 'patrol');
        // ★ 节点卡片只有点过「值班 Agent」标签才会渲染（`app.js:96`），所以顺序不能反。
        await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, '节点卡片渲染出来');
      });
      await sleep(1800);
      await scrollTo(cdp, '#events', 110);
    },
  },
  {
    id: 'ticket',
    caption: 'The RMA is filled in and ready, with the evidence and commands attached. It is left unsubmitted.',
    zh: '报修单已经填好，证据与命令都附上了，但故意不提交。',
    voice: 'The RMA is filled in and ready, with the evidence and commands attached. It is deliberately left unsubmitted.',
    hold: 10,
    run: async (cdp) => { await scrollTo(cdp, '#tickets', 110); await sleep(1200); await ring(cdp, ['#tickets']); },
  },
  {
    id: 'notify',
    caption: 'The on-call engineer is notified, with what happened and what is still waiting on them.',
    zh: '值班人会收到通知：发生了什么，以及还差他哪一步。',
    voice: 'The on-call engineer is notified, with what happened and what is still waiting on them.',
    hold: 8,
    run: async (cdp) => { await scrollTo(cdp, '#notifications', 110); await sleep(1000); await ring(cdp, ['#notifications']); },
  },
  {
    id: 'bench-1',
    caption: 'The same 14 cases, run two ways. The table lookup scores 11 out of 14.',
    zh: '同一个案例库的 14 道题，跑两条路径。查 Xid 码表那条对了 11 道。',
    voice: 'The same fourteen cases, run two ways. The table lookup scores eleven out of fourteen.',
    hold: 9,
    run: async (cdp) => {
      await clearRings(cdp);
      await clickTab(cdp, 'bench');
      await sleep(900);
      await click(cdp, '#run-bench');
      await mustWait(cdp,
        `/\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('#bench-rule').textContent)`,
        '基准规则分出现（如 11 / 14）');
      await sleep(700);
      await scrollTo(cdp, '#bench-rule');
      await ring(cdp, ['#bench-rule']);
    },
  },
  {
    id: 'bench-2',
    caption: 'All three misses need a cause rather than a code: the 30-day trend, and a secondary event read as the root cause.',
    zh: '错的三题都要看原因而不是码：30 天趋势，以及把次生事件当成了根因。',
    voice: 'All three misses need a cause, not a code. Reading the thirty-day trend, and telling a secondary event from the root cause.',
    hold: 11,
    run: async (cdp) => { await scrollTo(cdp, '#bench-tbl', 130); await sleep(1000); await ring(cdp, ['#bench-tbl']); },
  },
  {
    id: 'bench-3',
    caption: 'You can rerun this in the browser. Same code path as the scoring script.',
    zh: '这个数字你可以在浏览器里自己重跑，和评分脚本共用同一份代码。',
    voice: 'You can rerun it in the browser. Same code path as the scoring script.',
    hold: 6,
    run: async (cdp) => { await clearRings(cdp); },
  },
  {
    id: 'end',
    caption: 'Training Failure Triage turns a failure scene into an evidence-backed call, and this one was acted on.',
    zh: '训练故障分诊器把一次训练失败的现场变成有证据支撑的判断，而这一次已经被真的处置过。',
    voice: 'Training Failure Triage turns a failure scene into an evidence-backed call. This one was acted on.',
    hold: 8,
    run: async (cdp) => { await cdp.eval(`window.scrollTo({ top: 0, behavior: 'smooth' })`); },
  },
];

// ---------------------------------------------------------------- 只导出文案，不录制
//
// 放在这里（BEATS 之后、任何浏览器动作之前）是刻意的：
// 早先这个分支写在主流程里，结果它**先把线上模拟集群重置了一遍**才导出 ——
// 导出文案不该有副作用。现在它只读自己的常量。
//
// 字幕与配音都从这一份 BEATS 出，避免「视频里的文案」和「配音稿」各改各的、越走越远。
// 录过一次之后想改文案（比如去掉 AI 腔），不用重录：导出后重跑合成即可。
//   node scripts/record_demo.mjs --dump-beats --calls=17
if (argv.includes('--dump-beats')) {
  const calls = argv.find((a) => a.startsWith('--calls='))?.slice(8);
  if (calls) fillCalls(calls);
  const left = BEATS.filter((b) => (b.caption || '').includes('{calls}'));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'beats.json'), JSON.stringify({
    note: '由 record_demo.mjs --dump-beats 生成；字幕/中文/旁白三者的唯一来源是 BEATS',
    calls: calls || null,
    beats: BEATS.map((b) => ({ id: b.id, caption: b.caption, zh: b.zh, voice: b.voice, hold: b.hold })),
  }, null, 1));
  console.log(`已导出 ${BEATS.length} 拍到 ${OUT_DIR}/beats.json`);
  if (left.length) console.log(`★ 这些拍还留着 {calls} 未填：${left.map((b) => b.id).join('、')}（补 --calls=N）`);
  process.exit(left.length ? 1 : 0);
}

// ---------------------------------------------------------------- 主流程
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
});

console.log(`\n打开 ${APP_URL}\n`);
await cdp.guard('Page.navigate', { url: APP_URL });
await mustWait(cdp, `document.querySelectorAll('#case-select option').length > 0`, '应用挂载完成');
await sleep(1500);

// ---- 录前准备（不入镜）
// ★ 用 clickTab 而不是点 `#tab-patrol`：后者是面板 div，点了什么都不会发生。
//   之前这里既点错、又把 waitFor 的结果丢掉，于是安静空转 30 秒继续往下跑 ——
//   整场录的是「单次分诊」页。现在切换失败会直接抛错，不让它蒙混过关。
await clickTab(cdp, 'patrol');
await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, '节点卡片渲染出来');
await sleep(1200);

if (!NO_RESET) {
  console.log('重置模拟集群（不入镜，保证从干净的 6 节点 / 4 异常开始）…');
  await click(cdp, '#reset-cluster');
  await mustWait(cdp, `/已重置/.test(document.querySelector('#patrol-status').textContent)`, '重置完成提示');
  // ★ 为什么不能只等那句「已重置」：`app.js:711` 在 `await refreshCluster()` **之前**就把文案写好了，
  //   文案一到、事件列表可能还是上一场的残留。
  // ★ 为什么不能数 `#events li`：`renderEvents()` 在零事件时会渲染一条**占位** li
  //   （`暂无操作记录`，`index.html:130` 静态也带一条），所以 li 数永远 >= 1。
  //   真实事件一定带 class `ok` / `fail` / `info`，占位那条不带 —— 数带 class 的才准。
  //   开场画面必须与 deck 里「2 条 cordon」对得上，所以这里必须真的清干净。
  await mustWait(cdp, `document.querySelectorAll('${REAL_EVENTS}').length === 0`, '操作日志清空');
  await mustWait(cdp, `document.querySelectorAll('#nodes .node').length > 0`, '重置后节点卡片重新渲染');
  await sleep(1500);
}

const meta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);
// 同样只数带 class 的真实事件，别把占位的「暂无操作记录」算成一条
const events0 = await cdp.eval(`document.querySelectorAll('${REAL_EVENTS}').length`);
console.log(`集群读数：${meta}`);
console.log(`操作日志：${events0} 条`);

// ★ 开录前的最后一道闸：确认镜头对着的真的是「值班 Agent」面板。
//   之前就是这里没验，整场录成了「单次分诊」页而日志毫无异常。
const facing = await cdp.eval(`(() => {
  const vis = [...document.querySelectorAll('.tab')].filter((t) => !t.hidden).map((t) => t.id);
  return { visible: vis, tabOn: document.querySelector('#tabs button.on')?.textContent || '' };
})()`);
const facingOk = facing.visible.length === 1 && facing.visible[0] === 'tab-patrol';
console.log(`镜头对着：${facing.visible.join(',') || '（无）'}　当前标签：${facing.tabOn}`);
if (!facingOk) throw new Error(`开录前面板不对：可见面板是 ${facing.visible.join(',')}，应该只有 tab-patrol`);
console.log('开录\n');

// ---- 开录
t0 = Date.now();
capturing = true;
const captureTask = captureLoop(cdp, FPS);
await sleep(120);

const timeline = { app: APP_URL, fps: FPS, vw: VW, vh: VH, dry: DRY, beats: [] };
const now = () => (Date.now() - t0) / 1000;

/** 把字幕与旁白里的 `{calls}` 换成真实调用次数。DRY 下没跑巡检，填 `N` 明确表示「这个数没测到」。 */
function fillCalls(n) {
  for (const b of BEATS) {
    for (const k of ['caption', 'zh', 'voice']) {
      if (b[k]) b[k] = b[k].split('{calls}').join(String(n));
    }
  }
}
if (DRY) fillCalls('N');

let scale = 1;
for (let i = 0; i < BEATS.length; i += 1) {
  const b = BEATS[i];
  const start = now();
  console.log(`[${start.toFixed(1)}s] ${b.id}`);

  try { if (b.run) await b.run(cdp); } catch (e) { console.log(`  ! 动作失败：${e.message}`); }

  if (b.waitDone && !DRY) {
    const ok = await cdp.waitFor(`/^完成|^失败/.test(document.querySelector('#patrol-status').textContent)`,
      { timeout: 240000, interval: 600 });
    if (!ok) console.log('  ! 巡检没有在 240s 内结束，按当前画面继续');

    // ★ 检测到「完成」文案 ≠ 界面已经更新。
    //   `app.js` 里 setStatus('完成…') 写在 try 里，而 finally 里还有一次
    //   `await refreshCluster()`；文案先到、列表后到。不等这一下，后面的
    //   pair / oplog 拍会拍到还没更新的旧画面。
    const settled = await cdp.waitFor(`document.querySelectorAll('${REAL_EVENTS}').length > 0`,
      { timeout: 8000, interval: 300 });
    console.log(settled ? '  · 操作日志已落库并渲染' : '  · 等操作日志渲染超时（本次巡检可能没有执行任何动作）');

    // ★ 把字幕里的调用次数换成画面上的真实值，不许字幕自己报一个数
    const n = await cdp.eval(`(document.querySelector('#patrol-toolcount').textContent.match(/(\\d+)/) || [])[1]`);
    if (n) {
      console.log(`  · 字幕的调用次数改用画面真实值：${n}`);
    } else {
      console.log('  ! 读不到工具调用次数，字幕里先留占位符提示（不该出片）');
    }
    fillCalls(n || 'N');
  }

  const elapsed = now() - start;
  const want = b.waitDone ? Math.max(b.hold, elapsed) : b.hold * scale;
  if (want > elapsed) await sleep((want - elapsed) * 1000);

  const end = now();
  // ★ 中英文都要带上：漏掉 zh 的话画面上只剩一行英文，而合成脚本不会报错，
  //   只是静默地少一行 —— 所以这里显式写出，别用解构图省事。
  timeline.beats.push({ id: b.id, caption: b.caption, zh: b.zh, t0: start, t1: end });

  // 巡检那一段结束后，按剩余预算整体缩放后续停留时间，保证成片不超时
  if (b.waitDone) {
    const left = BEATS.slice(i + 1).reduce((s, x) => s + x.hold, 0);
    const budget = TARGET_TOTAL - end;
    // 下限 0.5 是为了「每一拍还看得清」。巡检万一跑得很慢，缩放到底也不够，
    // 那就只能如实报出来（先别提了重录）—— 超过 180s 是不符合提交要求，不是差不差一点。
    scale = Math.max(0.5, Math.min(1, budget / left));
    const projected = end + left * scale;
    console.log(`  · 到达 ${end.toFixed(1)}s，后续停留缩放 ×${scale.toFixed(2)}，预计成片 ${projected.toFixed(0)}s`);
    if (projected > 178) {
      console.log(`  ! 预计成片 ${projected.toFixed(0)}s 已顶到 180s 上限（这次巡检偏慢），建议重录一次。`);
    }
  }
}

await sleep(700);
capturing = false;
await captureTask;

// 出片前最后一道自检：字幕里不许还留着没被回填的占位符
const unfilled = BEATS.filter((b) => (b.caption || '').includes('{calls}') || (b.zh || '').includes('{calls}'));
if (unfilled.length) {
  throw new Error(`字幕里还有没回填的 {calls}：${unfilled.map((b) => b.id).join('、')}`);
}

timeline.duration = now();
timeline.frameCount = frames.length;
writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify({ ...timeline, frames }, null, 1));

const patrolStatus = await cdp.eval(`document.querySelector('#patrol-status').textContent.trim()`).catch(() => '');
const eventsN = await cdp.eval(`document.querySelectorAll('${REAL_EVENTS}').length`).catch(() => -1);

console.log('\n—— 录制结束 ——');
console.log(`  时长      ${timeline.duration.toFixed(1)}s`);
console.log(`  帧数      ${frames.length}（平均 ${(frames.length / timeline.duration).toFixed(1)} fps）`);
console.log(`  巡检状态  ${patrolStatus}`);
console.log(`  操作日志  ${events0} → ${eventsN} 条`);
// 慢抓帧 = 成片里可能的长冻帧。这里只报，真正的判罚在 demo_caption.py 里（超 4s 直接拒绝出片）。
if (slowPeeks.length) {
  const worst = slowPeeks.reduce((a, b) => (b.cost > a.cost ? b : a));
  const total = slowPeeks.reduce((s, x) => s + x.cost, 0) / 1000;
  console.log(`  慢抓帧    ${slowPeeks.length} 次 >900ms，合计 ${total.toFixed(1)}s，最慢 ${worst.cost}ms @ ${worst.t.toFixed(1)}s`);
} else {
  console.log('  慢抓帧    无（每次抓帧都 <900ms）');
}
console.log(`  产物      ${OUT_DIR}/frames/  +  timeline.json\n`);
if (!frames.length) console.log('★ 一帧都没录到，检查 captureScreenshot 是否可用');
