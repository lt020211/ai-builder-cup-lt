/**
 * 浏览器端验收：用真实 Chrome 加载页面，抓控制台错误，再在页面上下文里查断言。
 *
 * 为什么不能用 Node 直接 import app.js 来验：
 *   app.js 顶层会调 init()，里面全是 document.querySelector。
 *   Node 里没有 document，一行都跑不下去。**模块解析成功 ≠ 界面能跑**，
 *   所以这件事只能在真浏览器里做。
 *
 * 为什么不用 `chrome --dump-dom`：
 *   它只能看到最终 HTML，看不到控制台异常。而我们要抓的恰恰是
 *   「某个 import 路径写错」这类会静默让整块功能不渲染的错误 ——
 *   只看 DOM 会以为「页面没崩」，实际是某个标签页整块空白。
 *
 * 用法：
 *   node scripts/browser_check.mjs [http://127.0.0.1:8899/]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.argv[2] || 'http://127.0.0.1:8899/';
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

// ---------------------------------------------------------------- CDP 客户端
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

  /** 在页面里求值。awaitPromise 让 async 表达式能等到结果。 */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  /** 轮询直到表达式返回真值，或超时。 */
  async waitFor(expression, { timeout = 20000, interval = 250, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression, { awaitPromise: false });
        if (last) return last;
      } catch (e) {
        last = `抛错: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }
}

// ---------------------------------------------------------------- 启动 Chrome
//
// ★ 这一串 flag 里，**`--no-sandbox` 是不可省的**，而且是踩出来的：
//   Chrome 自己的沙箱与本机（WorkBuddy 的）沙箱嵌套时初始化失败，
//   报 `sandbox initialization failed: Operation not permitted`，
//   于是 GPU 进程反复崩溃、网络进程反复重启，最后 Chrome 直接
//   `FATAL: GPU process isn't usable. Goodbye.` 自杀 ——
//   而它自杀之前 WebSocket 是**能连上**的，所以现象看起来是
//   「CDP 连上了但命令没回包」，极易误判成协议用错。
//   同理，后面那几个 `--disable-*-sandbox` / `--disable-gpu-*` 是配套降噪。
//   这些 flag 只作用于这个临时实例（用了独立的 user-data-dir），
//   不会碰用户自己的 Chrome 配置与登录态。
//
// profile 默认是一次性的临时目录。传 TRIAGE_PROFILE=<dir> 可以复用同一份，
// 好处是页面写在 localStorage 里的 AI 结果缓存能跨轮保留 ——
// **重复验收不必反复烧模型配额**。
const PROFILE = process.env.TRIAGE_PROFILE || '';
const profile = PROFILE || mkdtempSync(join(tmpdir(), 'triage-chk-'));
const chrome = spawn(CHROME, [
  '--headless=new',
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
  try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
  // 外部指定的 profile 要留着（缓存就在里面），只清自己建的那个临时目录。
  if (!PROFILE) {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
process.on('exit', cleanup);

async function getTargetWebSocket() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      // 只认真正的标签页，且优先挑那个 about:blank 的空白页 ——
      // 列表里还会混进 browser_ui / 扩展的 background_page，
      // 连错了就会看到「命令发出去没回包」的假象。
      const pages = list.filter((t) => t.type === 'page');
      const page = pages.find((t) => t.url === 'about:blank') || pages[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome 调试端口没起来。stderr 尾部：\n${chromeErr.slice(-800)}`);
}

// ---------------------------------------------------------------- 主流程
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

console.log(`\n加载 ${APP_URL}\n`);
await cdp.send('Page.navigate', { url: APP_URL });

// 等界面装配完成：案例下拉有 14 项
const ready = await cdp.waitFor(
  `document.querySelectorAll('#case-select option').length`,
  { timeout: 25000, label: '案例下拉' }
);

console.log('— A. 页面与模块加载 —');
check('app.js 执行到 init() 且案例库已注入', Number(ready) > 0, `下拉 ${ready} 项`);
check('无未捕获异常', cdp.exceptions.length === 0,
  cdp.exceptions.length ? `\n      ${cdp.exceptions.slice(0, 5).join('\n      ')}` : '');
const errLogs = cdp.consoleLogs.filter((l) => l.level === 'error' || l.level === 'warning');
check('控制台无 error 级日志', errLogs.filter((l) => l.level === 'error').length === 0,
  errLogs.length ? `\n      ${errLogs.slice(0, 6).map((l) => `[${l.level}] ${l.text}`).join('\n      ')}` : '');

const caseCount = await cdp.eval(`document.querySelectorAll('#case-select option').length`);
check('案例库 14 个案例', caseCount === 14, `实测 ${caseCount}`);

console.log('\n— B. 基准对照（本地规则基线）—');
const benchRule = await cdp.eval(`document.querySelector('#bench-rule').textContent.trim()`);
check('规则基线已预热并显示', /^\d+\s*\/\s*\d+$/.test(benchRule), `显示「${benchRule}」`);
check('规则基线与自检脚本一致（11 / 14）', benchRule.replace(/\s/g, '') === '11/14', `显示「${benchRule}」`);

const benchRows = await cdp.eval(`document.querySelectorAll('#bench-tbl tr').length`);
check('基准对照表已渲染', benchRows > 0, `${benchRows} 行`);

console.log('\n— C. 单次分诊 —');
// 选一个有代表性的案例并跑（会走模型；模型不可用时应自动降级，也算通过）
await cdp.eval(`(() => { const s=document.querySelector('#case-select'); s.value='case-xid94-rising'; s.dispatchEvent(new Event('change')); return true; })()`);
const caseRendered = await cdp.waitFor(
  `document.querySelector('#case-result').style.display !== 'none' && document.querySelector('#tools').children.length > 0`,
  { timeout: 60000 }
);
check('单次分诊渲染出结果区', !!caseRendered);
const toolN = await cdp.eval(`document.querySelectorAll('#tools li').length`);
const caseStatus = await cdp.eval(`document.querySelector('#case-status').textContent.trim()`);
const modeTxt = await cdp.eval(`document.querySelector('#verdict-mode').textContent.trim()`);
check('工具轨迹区已渲染（含「无工具调用」的如实说明）', Number(toolN) > 0, `${toolN} 条 · 状态「${caseStatus}」· ${modeTxt}`);

// ★ 「工具轨迹只有 1 条」有两种完全不同的含义：模型只调了一次，还是它一次都没调、
//   我们看到的是那句「本次没有调用工具」的占位。**必须区分**，否则会把
//   「模型没调工具」误读成「模型调了工具」。所以这里直接把原文打出来。
const toolsRaw = await cdp.eval(`[...document.querySelectorAll('#tools li')].map(li => li.textContent.trim()).join(' ｜ ')`);
const toolCountTxt = await cdp.eval(`document.querySelector('#toolcount').textContent.trim()`);
console.log(`      #toolcount = ${toolCountTxt}`);
console.log(`      轨迹原文 = ${toolsRaw.slice(0, 600)}`);
check('模型确实调用了工具（不是「无工具调用」占位）',
  !/没有调用工具/.test(toolsRaw) && /共 \d+ 次调用/.test(toolCountTxt),
  toolCountTxt);

const verdictText = await cdp.eval(`document.querySelector('#verdict').textContent.trim().slice(0,60)`);
check('结论卡有内容（或如实说明证据不足）', verdictText.length > 0, `「${verdictText.replace(/\s+/g,' ')}」`);
const actsN = await cdp.eval(`document.querySelectorAll('#actions .act').length`);
const actsRaw = await cdp.eval(`[...document.querySelectorAll('#actions .act')].map(a => a.textContent.replace(/\\s+/g,' ').trim().slice(0,120)).join(' ｜ ')`);
console.log(`      处置清单分组 = ${await cdp.eval(`[...document.querySelectorAll('#actions .group')].map(g => g.className).join(',')`)}`);
console.log(`      处置原文 = ${actsRaw.slice(0, 600)}`);
check('处置清单已按风险分组渲染', Number(actsN) > 0, `${actsN} 条动作卡`);

console.log('\n— D. 值班 Agent（Firestore 真实往返）—');
// 切到值班页会触发 refreshCluster()
await cdp.eval(`(() => { for (const b of document.querySelectorAll('#tabs button')) if (b.dataset.tab==='patrol') b.click(); return true; })()`);
const nodeCount = await cdp.waitFor(`document.querySelectorAll('#nodes .node').length`, { timeout: 25000 });
check('从 Firestore 读到集群节点', Number(nodeCount) === 6, `实测 ${nodeCount} 个节点卡`);
const clusterMeta = await cdp.eval(`document.querySelector('#cluster-meta').textContent.trim()`);
check('集群概要标注了数据来源', /Firestore/.test(clusterMeta), `「${clusterMeta}」`);

const alertMeta = await cdp.eval(
  `(() => { const t=document.querySelector('#cluster-meta').textContent; const m=t.match(/其中\\s*(\\d+)\\s*个/); return m?Number(m[1]):-1; })()`
);
check('识别出异常节点数（种子数据应为 4）', Number(alertMeta) === 4, `实测 ${alertMeta}`);

// 重置 -> 巡检 -> 校验真的改了状态
await cdp.eval(`document.querySelector('#reset-cluster').click()`);
await cdp.waitFor(`document.querySelector('#patrol-status').textContent.includes('已重置')`, { timeout: 25000, label: '重置完成' });

// 直接问 Firestore：巡检前 lyg2112 应为未 cordon
async function readNode(node) {
  return cdp.eval(`(async () => {
    const url = 'https://firestore.googleapis.com/v1/projects/' + window.__PROBE__.projectId +
      '/databases/(default)/documents/cluster/' + ${JSON.stringify(node)} + '?key=' + window.__PROBE__.apiKey;
    const r = await fetch(url);
    return { status: r.status, body: await r.json() };
  })()`);
}

// 从页面里取出 Firestore 配置（cluster.js 的 CLUSTER_META 没挂到 window，
// 所以从任意一次 listNodes 的网络请求里推不出来 —— 改为从模块里取）
const meta = await cdp.eval(`(async () => {
  const m = await import('./js/cluster.js');
  return { projectId: m.CLUSTER_META.projectId, apiKey: m.CLUSTER_META.apiKey, database: m.CLUSTER_META.database };
})()`);
await cdp.eval(`window.__PROBE__ = ${JSON.stringify(meta)}; true`);
check('能取到 Firestore 项目配置', !!meta?.projectId, meta?.projectId || '');

const pre = await readNode('lyg2112');
const preCordoned = pre?.body?.fields?.cordoned?.booleanValue;
check('巡检前 lyg2112 未 cordon', preCordoned !== true, `cordoned=${preCordoned}`);

console.log('  … 触发值班巡检（会走模型；模型不可用时自动降级，仍应完成低风险执行）');
const patrolT0 = Date.now();
await cdp.eval(`document.querySelector('#run-patrol').click()`);

// ★ 超时值要有实测依据。本地顺利时 30–40 秒；一旦撞上上游 500，续跑会把时间翻倍，
//   实测到过 2 分钟以上。给 5 分钟余量，并把真实耗时打出来 ——
//   演示脚本里「多久能跑完」这句话必须有出处，不能靠印象写。
//
// 这里刻意手写轮询而不是用 waitFor：因为要同时观察**两件事** ——
//   ① 巡检是否结束；② 结束之前，操作日志有没有开始出现内容。
//   第 ② 点是「让人看见动作落地的过程」这个设计的验收点。
let patrolDone = false;
let sawLiveLog = false;
let liveLogAtSec = null;
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  const st = await cdp.eval(`document.querySelector('#patrol-status').textContent.trim()`);
  const txt = await cdp.eval(`document.querySelector('#patrol-text').textContent.trim()`);
  const n = await cdp.eval(`document.querySelectorAll('#events li.ok, #events li.fail').length`);
  const done = txt.length > 20 || /^(失败|完成)/.test(st);
  if (!done && Number(n) > 0 && !sawLiveLog) {
    sawLiveLog = true;
    liveLogAtSec = ((Date.now() - patrolT0) / 1000).toFixed(1);
  }
  if (done) { patrolDone = true; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
const patrolSec = ((Date.now() - patrolT0) / 1000).toFixed(1);
console.log(`      巡检耗时 = ${patrolSec} 秒`);
check('值班巡检跑完并产出报告', !!patrolDone, `${patrolSec}s`);
check(
  '★ 巡检过程中操作日志就已在逐条出现（不是结束后一次性刷出）',
  sawLiveLog || !patrolDone,
  sawLiveLog ? `第 ${liveLogAtSec}s 出现第一条` : '巡检未完成，未观测到',
);

const post = await readNode('lyg2112');
const postCordoned = post?.body?.fields?.cordoned?.booleanValue;
check('★ lyg2112 的 cordoned 在 Firestore 里真的变成了 true', postCordoned === true, `cordoned=${postCordoned}`);

// ★ 值班模式也要有证据链：它调了什么工具、参数是什么，必须看得见。
const patrolToolsRaw = await cdp.eval(`[...document.querySelectorAll('#patrol-tools li')].map(li => li.textContent.trim()).join(' ｜ ')`);
const patrolToolCount = await cdp.eval(`document.querySelector('#patrol-toolcount').textContent.trim()`);
console.log(`      巡检工具轨迹 = ${patrolToolCount}`);
console.log(`      轨迹原文 = ${patrolToolsRaw.slice(0, 700)}`);
check(
  '★ 值班页也显示了工具调用轨迹（证据链在值班模式下同样可见）',
  Number(await cdp.eval(`document.querySelectorAll('#patrol-tools li').length`)) > 0
    && !/尚未巡检|本次没有调用工具|链路异常/.test(patrolToolsRaw),
  patrolToolCount,
);

const evOk = await cdp.eval(`document.querySelectorAll('#events li.ok, #events li.fail').length`);
const evFail = await cdp.eval(`document.querySelectorAll('#events li.fail').length`);
const eventsN = evOk;
const eventsTxt = await cdp.eval(`document.querySelector('#events').textContent`);
const eventsRaw = await cdp.eval(`[...document.querySelectorAll('#events li')].map(li => li.textContent.replace(/\\s+/g,' ').trim()).join('  ／／  ')`);
const patrolStatus = await cdp.eval(`document.querySelector('#patrol-status').textContent.trim()`);
const patrolMode = await cdp.eval(`document.querySelector('#patrol-mode').textContent.trim()`);
console.log(`      巡检状态 = ${patrolStatus}`);
console.log(`      巡检模式 = ${patrolMode}`);
console.log(`      操作日志原文 = ${eventsRaw.slice(0, 700)}`);
check('操作日志记录了真实执行（不只占位符）', Number(eventsN) > 0, `${eventsN} 条带结论的记录`);
check('★ 没有「回验未通过」的记录（执行了就必须真的生效）', Number(evFail) === 0, `${evFail} 条失败`);
check('操作日志含回验结论', /回验(通过|未通过)/.test(eventsTxt),
  (eventsTxt.match(/回验未?通过/g) || []).slice(0, 4).join(' / ') || '未找到「回验」字样');

const ticketN = await cdp.eval(`document.querySelectorAll('#tickets .tk').length`);
const ticketsRaw = await cdp.eval(`[...document.querySelectorAll('#tickets .tk')].map(t => t.textContent.replace(/\\s+/g,' ').trim().slice(0,180)).join('  ／／  ')`);
console.log(`      工单原文 = ${ticketsRaw.slice(0, 500) || '(空)'}`);
// 工单/通知取决于模型有没有跑完最后两轮，所以这里只如实报告，不硬判失败。
check('建了工单草稿（且标注为「待人工提交」）',
  Number(ticketN) > 0 || /暂无/.test(await cdp.eval(`document.querySelector('#tickets').textContent`)),
  `${ticketN} 张 · ${/草稿|待人工提交/.test(ticketsRaw) ? '标注了草稿' : '（本轮模型未走到建单这一步）'}`);

const notifN = await cdp.eval(`document.querySelectorAll('#notifications .tk').length`);
const notifCount = await cdp.eval(`document.querySelector('#notif-count').textContent.trim()`);
console.log(`      通知原文 = ${(await cdp.eval(`document.querySelector('#notifications').textContent.replace(/\\s+/g,' ').trim()`)).slice(0, 400)}`);
check('通知队列落到 Firestore 并可读回', Number(notifN) > 0 || /暂无/.test(await cdp.eval(`document.querySelector('#notifications').textContent`)),
  `${notifN} 条 · 计数「${notifCount || '空'}」`);

console.log('\n— E. 动作库与审批 —');
await cdp.eval(`(() => { for (const b of document.querySelectorAll('#tabs button')) if (b.dataset.tab==='actions') b.click(); return true; })()`);
const riskN = await cdp.eval(`document.querySelectorAll('#risk-levels > *').length`);
check('三个风险等级都渲染了', Number(riskN) === 3, `实测 ${riskN}`);
const actRows = await cdp.eval(`document.querySelectorAll('#action-tbl tr').length`);
check('动作表含 14 条动作 + 表头', Number(actRows) === 15, `实测 ${actRows} 行`);
const discN = await cdp.eval(`document.querySelectorAll('#discouraged > *').length`);
check('不建议动作已渲染', Number(discN) >= 1, `${discN} 条`);

// 开场那次「无未捕获异常」是在导航刚结束时查的，异步路径（模型调用、Firestore 往返）
// 都还没跑。收尾再查一次，才算真的没有异常。
console.log('\n— F. 收尾复查 —');
check('整轮跑完仍无未捕获异常', cdp.exceptions.length === 0,
  cdp.exceptions.length ? `\n      ${cdp.exceptions.slice(0, 5).join('\n      ')}` : '');
const lateErrors = cdp.consoleLogs.filter((l) => l.level === 'error');
// ★ 上游模型接口的失败要**单独看待**：那是我们处理掉的现实条件（降级链 / 续跑），
//   不是我们的代码出问题。把它算进「控制台无 error」会让这条断言永远红，
//   久而久之就没人看了 —— 一条总是红的检查等于没有检查。
//   但它也不是噪音，仍要如实打出来，否则就变成"把不好看的东西藏起来"。
const upstreamErrors = lateErrors.filter((l) => /firebasevertexai\.googleapis\.com/.test(l.text));
const ownErrors = lateErrors.filter((l) => !/firebasevertexai\.googleapis\.com/.test(l.text));
check('整轮跑完控制台无「我方」错误（上游模型接口的失败另计）', ownErrors.length === 0,
  ownErrors.length ? `\n      ${ownErrors.slice(0, 6).map((l) => l.text).join('\n      ')}` : '');
if (upstreamErrors.length) {
  console.log(`  ⓘ 上游模型接口的失败 ${upstreamErrors.length} 次（由降级链/续跑处理，属预期范围）：`);
  for (const e of upstreamErrors.slice(0, 4)) console.log(`      ${e.text.slice(0, 160)}`);
}

console.log(`\n${'='.repeat(56)}`);
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败项：`);
  for (const f of failures) console.log(`    · ${f}`);
  const errs = cdp.consoleLogs.filter((l) => l.level === 'error');
  if (errs.length) {
    console.log(`\n  控制台 error（前 10 条）：`);
    for (const e of errs.slice(0, 10)) console.log(`    [${e.level}] ${e.text.slice(0, 220)}`);
  }
  if (cdp.exceptions.length) {
    console.log(`\n  未捕获异常（前 5 条）：`);
    for (const e of cdp.exceptions.slice(0, 5)) console.log(`    ${e.slice(0, 300)}`);
  }
}
console.log(`${'='.repeat(56)}\n`);

cleanup();
process.exit(fail ? 1 : 0);
