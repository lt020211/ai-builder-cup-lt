#!/usr/bin/env node
/**
 * 线上站点截图：给方案 deck 与文档提供**当前界面**的画面。
 *
 * 为什么要有它：本仓库早先提交的截图（`live-app-2026-10-14.png` / `live-app-final.png`，
 * 现已删除）拍的是**上一版界面**（标题还是「GPU 算力浪费审计器」、有碳曲线），
 * 而且它们是**贴进仓库的成品图** —— 界面一改，图就静默过期，没人会发现。
 * 这个脚本让截图随时可以重生成，并且顺手把裁图要用的几何量出来。
 *
 * 用法：
 *   node scripts/capture_shots.mjs [url] [outDir]
 *   node scripts/capture_shots.mjs [url] [outDir] --case case-xid94-rising
 *   node scripts/capture_shots.mjs [url] [outDir] --case case-xid94-rising --boxes shots/shift/boxes.json
 *
 * 默认拍 https://gpu-waste-auditor-2026.web.app 的四个标签页，输出到 ./shots/。
 *
 * ★ deck 用的两组就是这样出来的 —— 同一时刻界面只有一个状态，所以必须分两次采：
 *     # 刚重置的界面：集群状态整卡 / 节点行 / 风险块 / 基准对照表要的是这一组
 *     node scripts/capture_shots.mjs https://gpu-waste-auditor-2026.web.app \
 *          shots/clean --boxes shots/clean/boxes.json
 *     # 跑完一次值班之后：操作日志才非空，单次分诊才真跑过模型（消耗配额）
 *     node scripts/capture_shots.mjs https://gpu-waste-auditor-2026.web.app \
 *          shots/shift --case case-xid94-rising --boxes shots/shift/boxes.json
 *   裁图见 deck/make_crops.py：它按分组读各自的 boxes.json，**两组不能混用** ——
 *   被 cordon 的节点会多出一行「已停止接新任务…」，节点行的几何对不上。
 *
 * 传 `--case <id>` 会额外**真的跑一次单次分诊**并拍下结论 + 证据链 + 工具调用轨迹。
 * 这是 deck 里最值钱的一屏（「AI 不生成数字，它去取数字」就靠它），
 * 但它**会消耗模型配额**（这一版实测单次分诊 4 次工具调用，另有收尾的那次请求）。
 * 所以它不跑在默认路径上 —— 不传 `--case` 时本脚本零模型请求。
 *
 * 传 `--boxes <file>` 会把「每个面板在页面里的位置」量出来写成 JSON，给 deck 的
 * 裁图脚本（`deck/make_crops.py`）当坐标用。**必须在同一次会话里量**：
 * 换会话 → 视口/滚动/巡检残留状态都可能不同 → 坐标与截图错位；
 * 而且单次分诊要真跑才有 `#tools`，换个会话量就是白烧一次配额。
 * 量的是 CSS px（文档坐标，y 从页面顶端算），截图是 2 倍密度，裁切时统一 ×2。
 *
 * ★ 除此之外，本脚本不点任何会调用模型的按钮（基准页点的是「跑规则基线」，本地秒出）。
 *   值班页的操作日志若已有历史记录（此前跑过的巡检留下的），截图里会带上它 ——
 *   带 `回验通过` 的那几条正是 deck 里另一屏关键证据，而且不需要重跑巡检。
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

// ---------------------------------------------------------------- 几何转储（可选）
//
// 为什么要有这个开关（`--boxes <file>`）：
//   deck 的裁图脚本 `deck/make_crops.py` 需要「某个面板在页面里的哪一块」。
//   2026-10-14 界面从「卡片 + 右栏」改成「单栏工作台」，上一版**手写**的 6 组坐标
//   一个都没用了 —— 数字还是那些数字，但每个元素都挪了地方，照旧坐标裁出来的图
//   会切在半个面板上。手写坐标这种事，布局一动就静默失效。
//
//   所以改成量出来。而且必须在**同一次会话**里量：
//     · 换了会话，Chrome 视口、滚动位置、甚至巡检留下的状态都可能不同 → 坐标与截图错位；
//     · 单次分诊要真跑一次才有 `#tools`，换个会话量就是再烧一次模型配额。
//
//   量的是 **CSS px（文档坐标，y 从页面顶端算起）**，与 make_crops.py 同一套单位。
//   截图是 2 倍像素密度，裁切时统一 ×2 —— 这一点和原来一样。
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

/** 量一个标签页上的元素框。必须在**该标签可见时**调用：隐藏元素量出来全是 0。 */
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

  // 集群节点要逐行给框（deck 05 裁的是「前五行」）。
  // ★ 只在值班页量：`#nodes` 在别的标签页是 hidden 的，量出来是一排 0 ——
  //   把 0 写进 JSON 比不写更糟，读的人会以为「这一页有行，只是高度为 0」。
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

// ---------------------------------------------------------------- CDP 客户端
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
      } catch { /* 页面还没就绪 */ }
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }

  /** 整页截图（超出视口的部分也拍进去）。 */
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
    console.log(`  ✓ ${file.replace(`${ROOT}/`, '')}　${width}×${height}`);
    // ★ 截断必须说出来。上一版这个上限写的是 5200，而动作库那一页实际有 5200 高，
    //  于是它**正好**被切掉最后几行，日志里一个字的提示都没有 —— 那种
    //  「看起来截全了、其实少一段」的图拿去做 deck，是最难发现的一类错。
    if (full > height) {
      console.log(`    ⚠ 页面实际高 ${full}px，被 maxHeight=${maxHeight} 截断了 ${full - height}px`);
    }
  }
}

// ---------------------------------------------------------------- 启动 Chrome
//
// `--no-sandbox` 不可省：Chrome 自身沙箱与本机沙箱嵌套会初始化失败，
// 于是 GPU 进程反复崩、最后 Chrome 直接 `FATAL: GPU process isn't usable. Goodbye.`
// 自杀 —— 而它自杀之前 WebSocket 是**能连上**的，所以现象看起来是
// 「CDP 连上了但命令没回包」，极易误判成协议用错。理由同 browser_check.mjs。
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
  try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
    } catch { /* Chrome 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome 调试端口没起来。stderr 尾部：\n${chromeErr.slice(-800)}`);
}

// ---------------------------------------------------------------- 主流程
mkdirSync(OUT_DIR, { recursive: true });

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
// 1440×900 的屏 ×2 倍像素密度 —— deck 里放大也不糊
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});

console.log(`\n打开 ${APP_URL}\n`);
await cdp.send('Page.navigate', { url: APP_URL });
await cdp.waitFor(`document.querySelectorAll('#case-select option').length > 0`);
await new Promise((r) => setTimeout(r, 1200));

// 值班页的集群状态是从 Firestore 实时读的，等它渲染出来再拍照
await cdp.eval(`document.querySelector('[data-tab="patrol"]').click()`);
await cdp.waitFor(`document.querySelectorAll('#nodes .node').length > 0`, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

// 基准页：点「跑规则基线」——本地计算，不消耗任何配额
await cdp.eval(`document.querySelector('[data-tab="bench"]').click()`);
await cdp.eval(`document.querySelector('#run-bench').click()`);
await cdp.waitFor(`/\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('#bench-rule').textContent)`);
await new Promise((r) => setTimeout(r, 600));

const ruleScore = await cdp.eval(`document.querySelector('#bench-rule').textContent.trim()`);
const clusterMeta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);
const eventsCount = await cdp.eval(`document.querySelector('#events-count').textContent.trim()`);

console.log('  环境读数：');
console.log(`    基准页规则基线 = ${ruleScore}`);
console.log(`    集群状态       = ${clusterMeta}`);
console.log(`    操作日志       = ${eventsCount}`);

// ---- 逐页截图
const shots = [
  ['patrol', 'live-02-patrol.png', '值班 Agent'],
  ['bench', 'live-03-benchmark.png', '基准对照'],
  ['actions', 'live-04-actions.png', '动作库与审批'],
];

// 单次分诊放第一位，但如果要真跑一次，就先跑再拍（跑完之后页面停在结果态）
const triageShot = ['case', 'live-01-triage.png', '单次分诊'];

if (CASE_ID) {
  console.log(`\n★ 真的跑一次分诊：${CASE_ID}（会消耗模型配额，约 5–6 次请求）`);
  await cdp.eval(`document.querySelector('[data-tab="case"]').click()`);
  const picked = await cdp.eval(`(() => {
    const sel = document.querySelector('#case-select');
    const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(CASE_ID)});
    if (!opt) return null;
    // ★ 只改 value，**不要**派发 change —— 页面上 change 监听器本身就绑了 runCase()，
    //   再点一次 #run-case 会跑两遍，白烧一倍配额。
    sel.value = opt.value;
    return opt.textContent;
  })()`);
  if (!picked) throw new Error(`下拉里没有案例 ${CASE_ID}`);
  console.log(`  已选中：${picked}`);
  await cdp.eval(`document.querySelector('#run-case').click()`);

  // 结论区出现即算跑完（工具轨迹与处置清单在同一次渲染里）
  const done = await cdp.waitFor(
    `document.querySelector('#case-result').style.display !== 'none'
      && document.querySelectorAll('#tools li').length > 0`,
    { timeout: 180000, interval: 1000 },
  );
  if (!done) throw new Error('分诊没跑完（超时）');

  const verdict = await cdp.eval(`document.querySelector('#verdict').innerText.trim().slice(0, 300)`);
  const toolCount = await cdp.eval(`document.querySelector('#toolcount').textContent.trim()`);
  const modeText = await cdp.eval(`document.querySelector('#verdict-mode').textContent.trim()`);
  console.log(`  结论模式：${modeText}`);
  console.log(`  工具轨迹：${toolCount}`);
  console.log(`  结论摘录：${verdict.replace(/\n+/g, ' / ').slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 800));
}

console.log('\n截图：');
for (const [tab, file, label] of [triageShot, ...shots]) {
  await cdp.eval(`document.querySelector('[data-tab="${tab}"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  console.log(`  · ${label}`);
  await cdp.shot(join(OUT_DIR, file));
  await dumpBoxes(tab);   // ★ 必须在切走之前量：隐藏的元素量出来全是 0
}

if (BOXES_OUT) {
  writeFileSync(BOXES_OUT, `${JSON.stringify(boxes, null, 2)}\n`);
  const n = Object.values(boxes).reduce((a, t) => a + Object.keys(t || {}).length, 0);
  console.log(`\n几何已转储：${BOXES_OUT.replace(`${ROOT}/`, '')}（${n} 个元素框，CSS px）`);
}

console.log('\n完成。');
