/**
 * 端到端契约测试：用**桩 fetch** 在 Node 里把「模型 → 工具 → 模型 → 结果」整条链路跑通。
 *
 * 为什么必须有这个文件
 * --------------------
 * 单次分诊与值班巡检各自有一个 `finish()`，把在线结果打包成界面消费的对象。
 * 它们原先都长这样：
 *
 *     packResult(state, { mode, text, model: extra.model || '', error })
 *     if (extra.degraded) out.degraded = extra.degraded;
 *
 * 也就是只把 `model` 与 `degraded` 挑出来。于是 `tool_calls` 被静默丢掉了。
 * 后果：模型明明调了 lookup_xid / inspect_node（citations 里一条不差地记着），
 * 界面上「AI 的工具调用轨迹」却永远显示「本次没有调用工具」。
 * 被藏起来的恰恰是整个演示最值钱的证据。
 *
 * 这个 bug 靠读代码发现不了（两个函数相隔一百多行、写法还完全一样），
 * 靠 `verify_triage.mjs` 也发现不了（它只查不变量，不跑链路）。
 * 唯一能挡住它的，就是**真的跑一遍链路**。所以这个文件存在的意义就是它。
 *
 * 不需要网络、不需要 Firestore、不消耗模型配额：
 *   · 模型这一侧用桩 fetch 喂固定的响应
 *   · 集群这一侧用内存里的假客户端
 *
 * 用法：node scripts/verify_pipeline.mjs
 */

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

// ---------------------------------------------------------------- 桩：模型
/**
 * 按脚本依次吐出响应。每条脚本项是 `parts` 数组，例如
 *   [{ functionCall: { name: 'lookup_xid', args: { code: 94 } } }]
 *   [{ text: '最终结论……' }]
 * 也支持用 `{ __error: { status, body } }` 模拟一次上游失败（用于验证续跑）。
 *
 * 同时把每次请求体记下来 —— 我们要断言 contents 的角色纪律（见 P1b）。
 */
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
    // 脚本用尽还继续要 —— 说明链路多跑了一轮，直接报出来
    return geminiErr(500, `桩脚本已用尽（第 ${cursor + 1} 次请求）`);
  }
  const item = script[cursor++];
  if (item && item.__error) return geminiErr(item.__error.status, item.__error.body);
  return geminiOk(item);
};

// ---------------------------------------------------------------- 桩：集群
/** 内存版集群客户端，形状与 cluster.js 对齐（tools.js 只用到这六个方法）。 */
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
      if (!n) return { ok: false, error: `没有节点 ${node}` };
      const before = { ...n };
      n.cordoned = true;
      n.schedulable = false;
      const ifaces = { cordoned: true, schedulable: false };
      const describe = `禁止 ${node} 接新任务；节点上 ${(n.jobs || []).length} 个正在运行的任务未受影响`;
      // ★ 这个 event 的字段必须与 cluster.js 里**真实的**那只保持一致：
      //   node / action_id / action_label / risk / actor / reason / describe /
      //   fields_written / status / verified / error / at
      //   第一次写这个假对象时漏了 verified，于是 P2 报「回验字段没带出来」——
      //   查下去才发现真代码是对的、假对象是错的。
      //   教训：假对象形状跟真东西不一致，测试就在证明一个不存在的事实。
      const event = {
        node,
        action_id: actionId,
        action_label: '禁止节点接新任务（cordon）',
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
  if (!c) throw new Error(`cases.json 里没有 ${id}`);
  return c;
}

// ======================================================================
console.log('\n— P0. 静态护栏：打包结果只能有一个出口 —');
{
  const SRC = readFileSync(join(HERE, '..', 'firebase', 'public', 'js', 'ai.js'), 'utf8');
  // ★ 必须先剥掉注释再匹配。
  //   finishResult 的文档注释里**故意引用了那句坏写法**作为反例，
  //   不剥注释的话，护栏会被自己的说明文字绊倒 —— 第一次跑就报了假警。
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  ok(/function finishResult\(/.test(CODE), '存在唯一的 finishResult() 出口');

  // 上一次的 bug 长这样：手写一个局部 finish，只挑 model / degraded。
  // 这条断言直接盯住那个写法本身 —— 它一旦回来，这里就红。
  const handRolled = /packResult\(\s*state\s*,\s*\{\s*mode\s*,\s*text\s*,\s*model:/.test(CODE);
  ok(
    !handRolled,
    '★ 没有手写的「只挑字段」式 finish（tool_calls 曾被它丢掉）',
    handRolled ? '又出现了 packResult(state, { mode, text, model: … }) 这种写法' : '',
  );

  // 两个入口都必须经由 finishResult，不能再各自实现
  const callSites = (CODE.match(/finishResult\(state, mode, text, extra, error\)/g) || []).length;
  ok(callSites === 2, 'diagnose 与 patrol 两个入口都走 finishResult', `实测 ${callSites} 处`);

  ok(
    /broken\s*=\s*mode === 'gemini' && !Array\.isArray\(extra\.tool_calls\)/.test(CODE),
    '★ gemini 路径若拿不到数组，会被标成链路问题而不是「没调用工具」',
  );
}

console.log('\n— P1. 单次分诊：工具轨迹必须原样带出来 ★ 回归点 —');
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
          title: '提交硬件报修（RMA）',
          detail: 'Xid 94 频次上升叠加 Xid 95，属硬件劣化。',
          classification: 'hardware',
          confidence: 0.95,
          should_rma: true,
          evidence_refs: ['T1', 'T2', 'T3'],
        },
      },
    }],
    [{ text: '**一句话结论**：硬件劣化，走 RMA。' }],
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-rising') });

  ok(out.mode === 'gemini', 'mode 为 gemini（模型路径生效）', out.mode);
  ok(Array.isArray(out.tool_calls), '★ out.tool_calls 是数组而不是 undefined', JSON.stringify(out.tool_calls));
  ok(
    Array.isArray(out.tool_calls) && out.tool_calls.length === 4,
    '★ 4 次工具调用全部被带出（曾经这里是 undefined）',
    `实测 ${Array.isArray(out.tool_calls) ? out.tool_calls.length : 'undefined'}`,
  );
  const names = (out.tool_calls || []).map((c) => c.name);
  ok(
    names.join(',') === 'lookup_xid,lookup_xid,inspect_node,propose_fix',
    '调用顺序与参数被忠实记录',
    names.join(' → '),
  );
  ok(out.citations.length === 3, '3 条引用登记（T1/T2/T3）', `实测 ${out.citations.length}`);
  ok(out.actions.length === 1, '登记了 1 条处置建议', `实测 ${out.actions.length}`);
  ok(out.actions[0]?.risk === 'high', '风险等级由动作库给出＝high（模型无从干预）', out.actions[0]?.risk);
  ok(
    (out.actions[0]?.evidence_refs || []).length === 3,
    '3 条引用原样挂在建议上（可指回产生它的那次调用）',
    JSON.stringify(out.actions[0]?.evidence_refs),
  );
}

console.log('\n— P1b. contents 角色纪律：工具结果必须以 user 回传 —');
{
  // 第 2 次请求应该是「模型发起工具调用 → 工具结果」之后的续写。
  // 按 Gemini 的规矩，工具结果必须用 role: 'user'，用 'function' 会被拒。
  const second = requests[1]?.body;
  const contents = second?.contents || [];
  ok(contents.length >= 3, '第 2 次请求带上了历史 contents', `${contents.length} 段`);
  ok(contents[0]?.role === 'user', '第 1 段是 user（初始提示）', contents[0]?.role);
  ok(contents[1]?.role === 'model', '第 2 段是 model（原样回传，保住 thoughtSignature）', contents[1]?.role);
  const last = contents[contents.length - 1];
  ok(last?.role === 'user', '★ 工具结果段角色是 user 而不是 function', last?.role);
  ok(
    (last?.parts || []).some((p) => p.functionResponse),
    '工具结果段装的是 functionResponse',
    JSON.stringify((last?.parts || []).map((p) => Object.keys(p))),
  );
  ok(
    (last?.parts || []).every((p) => p.functionResponse?.name),
    '每个 functionResponse 都带 name（模型才知道这是哪个工具的结果）',
  );
}

console.log('\n— P2. 值班巡检：轨迹 + 执行 + 工单 + 通知 —');
{
  installScript([
    [{ functionCall: { name: 'scan_cluster', args: { include_healthy: false } } }],
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'cordon_node', reason: 'Xid 94 上升，先止损' },
      },
    }],
    [{
      functionCall: {
        name: 'draft_ticket',
        args: {
          node: 'lyg2112', action_id: 'file_rma', title: '申请 RMA 更换 GPU 3',
          body: '近 30 天 Xid 94 累计 53 次，ECC 上升。', priority: 'high',
          evidence_refs: ['T1'],
        },
      },
    }],
    [{
      functionCall: {
        name: 'notify_operator',
        args: {
          node: 'lyg2112', title: '等待审批 RMA',
          text: '已 cordon 止损，工单草稿就绪。', severity: 'critical',
        },
      },
    }],
    [{ text: '**值班小结**：1 个节点已 cordon，1 张工单待批准。' }],
  ]);

  const cluster = fakeCluster(seed);
  const out = await patrol({ cluster, clusterMeta: { node_count: 6 } });

  ok(out.mode === 'gemini', 'mode 为 gemini（模型路径生效）', out.mode);
  ok(
    Array.isArray(out.tool_calls) && out.tool_calls.length === 4,
    '★ 巡检的 4 次工具调用也被带出（同一处 bug 的第二个落点）',
    `实测 ${Array.isArray(out.tool_calls) ? out.tool_calls.length : 'undefined'}`,
  );
  ok(out.executions.length === 1, '执行了 1 个动作', `实测 ${out.executions.length}`);
  ok(
    out.executions[0]?.event?.verified === true,
    '★ 执行结果的回验字段被带出且为通过',
    JSON.stringify(out.executions[0]?.event?.verified),
  );
  ok(out.tickets.length === 1, '建了 1 张工单', `实测 ${out.tickets.length}`);
  ok(out.tickets[0]?.status === 'draft', '★ 工单是草稿，不是已提交', out.tickets[0]?.status);
  ok(out.tickets[0]?.approved === false, '工单未获批（提交必须由人做）', String(out.tickets[0]?.approved));
  ok(out.notifications.length === 1, '投递了 1 条通知', `实测 ${out.notifications.length}`);
  ok(out.notifications[0]?.status === 'queued', '通知状态如实为 queued（不假装已送达）', out.notifications[0]?.status);
  ok(cluster._store.lyg2112.cordoned === true, '★ 集群状态真的被改了（不是界面动画）');
}

console.log('\n— P3. 中/高风险动作在执行层被拒，且提示语是「审批」而不是「没连集群」 —');
{
  installScript([
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'gpu_reset', reason: '试试复位' },
      },
    }],
    [{ text: '被拒了，改用 propose_fix。' }],
  ]);

  const out = await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });
  // 工具结果原文在 requests[1] 里（第 2 次请求带回了 functionResponse）
  const fr = requests[1]?.body?.contents?.slice(-1)[0]?.parts?.[0]?.functionResponse;
  const result = fr?.response?.result || {};
  ok(result.refused === true, '中风险 gpu_reset 被拒绝执行', String(result.refused));
  ok(
    typeof result.error === 'string' && /审批/.test(result.error) && !/没有连接集群/.test(result.error),
    '★ 拒绝理由说的是「需要人工审批」，没有把它伪装成环境问题',
    String(result.error).slice(0, 60),
  );
  ok(Array.isArray(result.allowed_to_execute_now), '同时告诉模型「哪些才是你能做的」', `${(result.allowed_to_execute_now || []).length} 条`);
  ok(out.executions.length === 0, '被拒的动作没有产生执行记录', `实测 ${out.executions.length}`);
}

console.log('\n— P4. 模型一次工具都没调：必须如实为 0，而不是字段丢失 —');
{
  installScript([[{ text: '我直接给结论，不查工具。' }]]);
  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });
  ok(out.mode === 'gemini', 'mode 仍为 gemini（模型确实响应了）', out.mode);
  ok(Array.isArray(out.tool_calls), '★ tool_calls 是空数组，而不是 undefined', JSON.stringify(out.tool_calls));
  ok(out.tool_calls.length === 0, '如实记录 0 次调用（界面据此说「直接作答」）', `实测 ${out.tool_calls.length}`);
  ok(out.citations.length === 0, '没有引用', `实测 ${out.citations.length}`);
}

console.log('\n— P5. 离线路径：不许声称调用工具，且处置清单不能为空 —');
{
  installScript([]); // 离线路径不该发任何请求
  const out = await diagnose({ caseObj: pickCase('case-xid94-rising'), enabled: false });
  ok(out.mode === 'offline', 'mode 为 offline', out.mode);
  ok(requests.length === 0, '★ 离线路径一次网络请求都没发', `${requests.length} 次`);
  ok(out.tool_calls.length === 0, '没有工具调用（如实）', `实测 ${out.tool_calls.length}`);
  ok(
    out.actions.length > 0,
    '★ 处置清单非空（规则给出的动作也要登记进 state，否则文本与清单对不上）',
    `实测 ${out.actions.length} 条`,
  );
  ok(
    out.actions.every((a) => a.risk === 'low'),
    '离线路径只给低风险动作（不替人做中高风险决策）',
    out.actions.map((a) => a.risk).join(','),
  );
}

console.log('\n— P6. 模型连续调工具不收敛：必须报错，不能假装完成 —');
{
  // 比 MAX_TOOL_TURNS 更多的工具调用轮次
  installScript(Array.from({ length: 20 }, () => [
    { functionCall: { name: 'lookup_xid', args: { code: 94 } } },
  ]));
  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });
  ok(out.mode === 'fallback', '不收敛时降级为规则路径', out.mode);
  ok(typeof out.error === 'string' && out.error.length > 0, '把失败原因写进结果', String(out.error).slice(0, 80));
  ok(out.degraded?.length > 0, '记录了「为什么换了模型」供界面显示', `${out.degraded?.length || 0} 条`);
}

console.log('\n— P7. 模式即能力边界：单次分诊拿不到执行/触达的钥匙 —');
{
  // 单次分诊：没有连集群，就不该声明需要集群的工具
  installScript([[{ text: '直接给结论。' }]]);
  await diagnose({ caseObj: pickCase('case-xid94-single') });
  const caseTools = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

  ok(caseTools.length > 0, '单次分诊确实声明了工具', `${caseTools.length} 个`);
  for (const forbidden of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(
      !caseTools.includes(forbidden),
      `★ 单次分诊没有声明 ${forbidden}（本模式没连集群，调了只会拿到「没有连接集群」）`,
    );
  }
  for (const needed of ['lookup_xid', 'inspect_node', 'propose_fix']) {
    ok(caseTools.includes(needed), `单次分诊保留了 ${needed}`);
  }

  // 值班巡检：全套
  installScript([[{ text: '巡检小结。' }]]);
  await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });
  const patrolTools = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

  ok(patrolTools.length === 10, '★ 值班巡检拿到全套 10 个工具', `实测 ${patrolTools.length}`);
  for (const needed of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(patrolTools.includes(needed), `值班巡检有 ${needed}`);
  }
  ok(
    patrolTools.length > caseTools.length,
    '★ 两个模式的能力差异是**真的**（工具集不同），不只是提示词措辞不同',
    `case ${caseTools.length} 个 / patrol ${patrolTools.length} 个`,
  );
}

console.log('\n— P8. 提示词与工具声明必须说同一件事 —');
{
  const ALL = [
    'scan_cluster', 'search_failure_signature', 'lookup_xid', 'check_compat',
    'estimate_memory', 'inspect_node', 'execute_action', 'draft_ticket',
    'notify_operator', 'propose_fix',
  ];
  const mentioned = (text) => ALL.filter((t) => new RegExp(`\\b${t}\\b`).test(text || ''));

  // 单次分诊
  installScript([[{ text: '结论。' }]]);
  await diagnose({ caseObj: pickCase('case-xid94-single') });
  const casePrompt = requests[0]?.body?.contents?.[0]?.parts?.[0]?.text || '';
  const caseDeclared = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  const caseMentioned = mentioned(casePrompt);
  const caseOrphans = caseMentioned.filter((t) => !caseDeclared.includes(t));
  ok(
    caseOrphans.length === 0,
    '★ 单次分诊的提示词没有提到它拿不到的工具',
    caseOrphans.length ? `提到了但没声明：${caseOrphans.join(', ')}` : `提到 ${caseMentioned.length} 个，全部已声明`,
  );

  // 值班巡检
  installScript([[{ text: '巡检小结。' }]]);
  await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });
  const patrolPrompt = requests[0]?.body?.contents?.[0]?.parts?.[0]?.text || '';
  const patrolDeclared = (requests[0]?.body?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  const patrolMentioned = mentioned(patrolPrompt);
  const patrolOrphans = patrolMentioned.filter((t) => !patrolDeclared.includes(t));
  ok(
    patrolOrphans.length === 0,
    '★ 值班巡检的提示词也没有提到未声明的工具',
    patrolOrphans.length ? `提到了但没声明：${patrolOrphans.join(', ')}` : `提到 ${patrolMentioned.length} 个，全部已声明`,
  );

  for (const t of ['scan_cluster', 'execute_action', 'draft_ticket', 'notify_operator']) {
    ok(
      patrolMentioned.includes(t) && !caseMentioned.includes(t),
      `「${t}」只出现在值班模式的提示词里`,
    );
  }
}

console.log('\n— P9. 上游 500 之后必须「带进度续跑」，不能整段重来 —');
{
  installScript([
    [{ functionCall: { name: 'scan_cluster', args: { include_healthy: false } } }],
    { __error: { status: 500, body: 'upstream internal error' } },
    [{
      functionCall: {
        name: 'execute_action',
        args: { node: 'lyg2112', action_id: 'cordon_node', reason: '先止损' },
      },
    }],
    [{
      functionCall: {
        name: 'draft_ticket',
        args: {
          node: 'lyg2112', action_id: 'file_rma', title: '申请 RMA',
          body: 'Xid 94 上升。', evidence_refs: [],
        },
      },
    }],
    [{
      functionCall: {
        name: 'notify_operator',
        args: { node: 'lyg2112', title: '待审批 RMA', text: '已 cordon。', severity: 'critical' },
      },
    }],
    [{ text: '**值班小结**：已完成止损、备好工单、发出通知。' }],
  ]);

  const out = await patrol({ cluster: fakeCluster(seed), clusterMeta: { node_count: 6 } });

  ok(out.resumed === true, '★ 结果里标明了这次是「带进度续跑」的', String(out.resumed));
  ok(out.mode === 'gemini', '最终仍然由模型完成（没有退化成规则兜底）', out.mode);
  ok(
    (out.tool_calls || []).length === 4,
    '★ 4 次调用跨模型保留 —— 上游 500 前的那次 scan_cluster 没被丢掉',
    (out.tool_calls || []).map((c) => c.name).join(' → '),
  );
  ok(
    out.tool_calls[0]?.name === 'scan_cluster',
    '第 1 次仍是上一个模型的调用（说明续跑真的接上了历史）',
    out.tool_calls[0]?.name,
  );
  ok(out.tickets.length === 1, '★ 续跑后工单建出来了（整段重来时会丢）', `实测 ${out.tickets.length}`);
  ok(out.notifications.length === 1, '★ 续跑后通知也发出了', `实测 ${out.notifications.length}`);
  ok(out.executions.length === 1 && out.executions[0]?.event?.verified === true, 'cordon 执行并回验通过');
  ok(
    (out.degraded || []).some((d) => /500/.test(String(d.reason)) || /upstream/.test(String(d.reason))),
    '把这次上游失败如实记进 degraded（界面会显示原因）',
    (out.degraded || []).map((d) => `${d.model}: ${String(d.reason).slice(0, 40)}`).join(' ｜ '),
  );
}

console.log('\n— P10. 撞上轮次上限时，已完成的调用不能丢 ★ 线上实测踩到的 —');
{
  // 连续 12 轮都只调工具 → 触发 MAX_TOOL_TURNS → 换模型续跑
  installScript([
    ...Array.from({ length: 12 }, () => [
      { functionCall: { name: 'lookup_xid', args: { code: 94 } } },
    ]),
    [{ text: '最终结论：硬件方向。' }],
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });

  ok(out.resumed === true, '★ 撞上限后带进度换模型，而不是从头来', String(out.resumed));
  ok(out.mode === 'gemini', '最终由模型完成', out.mode);
  ok(
    (out.tool_calls || []).length === 12,
    '★ 12 次调用全部保留（线上曾出现过「引用表 18 条、轨迹只有 5 条」）',
    `实测 ${(out.tool_calls || []).length}`,
  );
  ok(
    out.citations.length === out.tool_calls.length,
    '★ 引用数与调用数一致（这条不变量是「证据链完整」的定义）',
    `${out.citations.length} 引用 / ${out.tool_calls.length} 调用`,
  );
  ok(!out.pipeline_error, '没有触发「链路异常」提示', String(out.pipeline_error || '（无）'));
}

console.log('\n— P11. 「引用数 > 调用数」必须被识别成链路异常，而不是装作没事 —');
{
  // 调用过一次（留下 1 条引用）之后上游持续失败 → 最终降级。
  // 这时 state 里有引用、tool_calls 却是空的 —— 界面必须说清这是链路问题。
  installScript([
    [{ functionCall: { name: 'lookup_xid', args: { code: 94 } } }],
    { __error: { status: 500, body: 'boom 1' } },
    { __error: { status: 500, body: 'boom 2' } },
    { __error: { status: 500, body: 'boom 3' } },
    { __error: { status: 500, body: 'boom 4' } },
    { __error: { status: 500, body: 'boom 5' } },
  ]);

  const out = await diagnose({ caseObj: pickCase('case-xid94-single') });

  ok(out.mode === 'fallback', '上游持续失败 → 降级为规则路径', out.mode);
  ok(out.citations.length > 0, '但引用确实留下了（说明模型跑过）', `${out.citations.length} 条`);
  ok(out.tool_calls.length === 0, '调用轨迹是空的（记录丢了）', `${out.tool_calls.length} 条`);
  ok(
    typeof out.pipeline_error === 'string' && /引用/.test(out.pipeline_error),
    '★ 界面会显示「链路异常」并解释引用与调用数对不上，而不是显示「本次没有调用工具」',
    String(out.pipeline_error || '（无）').slice(0, 90),
  );
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  契约测试通过 ${pass} / ${pass + failures.length}`);
if (failures.length) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    · ${f}`);
}
console.log(`  （模型降级链：${MODEL_CHAIN.join(' → ')}；本测试全部走桩，未消耗配额）`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failures.length ? 1 : 0);
