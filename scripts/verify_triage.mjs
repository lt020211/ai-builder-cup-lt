#!/usr/bin/env node
/**
 * 训练故障分诊器 · 自检脚本
 *
 * 运行：node scripts/verify_triage.mjs
 *
 * 这个脚本承担两件事，而且第二件比第一件重要：
 *
 *   1. 不变量校验：动作库的每条动作是否合规、审批门槛是否真的拦得住、
 *      模型能不能绕过风险等级、案例库结构是否完整。
 *
 *   2. ★ F8 基准：用**纯规则路径**把全部案例跑一遍，如实报告它判对多少。
 *      这个数字是会写进 deck 和界面的，所以它必须来自实际运行，
 *      不能由人凭感觉填。跑出来是 11/14 就写 11/14。
 *
 * 为什么要有第 2 件：本次参赛的核心论点是「这件事规则做不好、必须上模型」。
 * 这个论点是**可证伪**的——所以必须真的跑一遍去证伪它，而不是宣称它。
 */

import fs from 'node:fs';
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

// ======================================================================
rule('A. 动作库不变量');
// ======================================================================
const RISKS = ['low', 'medium', 'high'];
const placeholder = /<([A-Z0-9_]+)>/g;

for (const a of actions.ACTION_LIST) {
  ok(RISKS.includes(a.risk), `${a.id}: risk 非法（${a.risk}）`);
  ok(typeof a.label === 'string' && a.label.length > 0, `${a.id}: 缺 label`);
  ok(typeof a.affects === 'string' && a.affects.length > 0, `${a.id}: 缺影响面描述`);
  ok(Array.isArray(a.cmds) && a.cmds.length > 0, `${a.id}: 缺命令`);
  ok(typeof a.expect === 'string' && a.expect.length > 0, `${a.id}: 缺预期输出`);
  ok(
    typeof a.rollback === 'string' && a.rollback.trim().length > 0,
    `${a.id}: 缺回滚方案——没有回滚方案的动作不允许进执行包`,
  );
  // 命令里的 <占位符> 必须都在 params 里声明，且反过来也要成立
  const inCmd = new Set();
  for (const c of a.cmds) for (const m of c.matchAll(placeholder)) inCmd.add(m[1]);
  for (const p of inCmd) ok(a.params.includes(p), `${a.id}: 命令里出现 <${p}> 但 params 未声明`);
  for (const p of a.params) ok(inCmd.has(p), `${a.id}: params 声明了 ${p} 但命令里没有`);
  ok(
    a.applies_to.every((c) => Object.hasOwn(kb.CLASSES, c)),
    `${a.id}: applies_to 含未知分类（${a.applies_to.join(',')}）`,
  );
}

const byRisk = {};
for (const a of actions.ACTION_LIST) byRisk[a.risk] = (byRisk[a.risk] || 0) + 1;

const selectable = actions.selectableActions();
const discIds = Object.keys(actions.DISCOURAGED_ACTIONS);
ok(
  !selectable.some((a) => discIds.includes(a.id)),
  `被标记不建议的动作出现在了模型候选清单里：${discIds.join(',')}`,
);
ok(
  selectable.length === actions.ACTION_LIST.length,
  `候选清单数量与动作库不一致（${selectable.length} vs ${actions.ACTION_LIST.length}）`,
);

line(`动作总数：${actions.ACTION_LIST.length}　` +
  `风险分布：低 ${byRisk.low || 0} / 中 ${byRisk.medium || 0} / 高 ${byRisk.high || 0}`);
line(`给模型的候选：${selectable.length} 条　不进候选的「不建议」动作：${discIds.join('、')}`);

// ======================================================================
rule('B. 审批门槛：该拦的必须拦住');
// ======================================================================
const approvalChecks = [
  {
    name: '高风险 + 已批准但无变更单号 → 必须拦住',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: '', approver: 'litao' },
    expectOk: false,
  },
  {
    name: '高风险 + 有单号但无审批人 → 必须拦住',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: 'CHG-1', approver: '' },
    expectOk: false,
  },
  {
    name: '高风险 + 单号与审批人齐全 → 放行',
    args: { actionIds: ['file_rma'], approvals: { file_rma: { decision: 'approve' } }, ticket: 'CHG-1', approver: 'litao' },
    expectOk: true,
  },
  {
    name: '中风险 + 未勾选影响面 → 必须拦住',
    args: { actionIds: ['reboot_node'], approvals: { reboot_node: { decision: 'approve' } } },
    expectOk: false,
  },
  {
    name: '中风险 + 已勾选影响面 → 放行',
    args: { actionIds: ['reboot_node'], approvals: { reboot_node: { decision: 'approve', impact_ack: true } } },
    expectOk: true,
  },
  {
    name: '低风险 + 直接批准 → 放行（不需要额外条件）',
    args: { actionIds: ['restart_job'], approvals: { restart_job: { decision: 'approve' } } },
    expectOk: true,
  },
  {
    name: '低风险 + 拒绝 → 放行（不执行不需要满足条件）',
    args: { actionIds: ['restart_job'], approvals: { restart_job: { decision: 'reject' } } },
    expectOk: true,
  },
];

for (const c of approvalChecks) {
  const v = actions.validateApproval(c.args);
  const pass = c.expectOk ? v.ok : !v.ok;
  ok(pass, `审批判定不符预期：${c.name}（实际 ok=${v.ok}，理由 ${v.blocking.join('；') || '无'}）`);
  line(`${pass ? '通过' : '失败'}　${c.name}`);
}

// ======================================================================
rule('C. ★ 模型能不能绕过风险等级');
// ======================================================================
/** 造一个最小可用证据包，只为让 ToolState 能构造出来。 */
const emptyEvidence = triage.normalizeEvidence({ id: 'verify', evidence: {} });

function freshState() {
  return new tools.ToolState(emptyEvidence, triage.preAnalyze(emptyEvidence));
}

// C0 分发表里的每个工具名都必须在 ToolState 上真的有一个同名方法。
// 这条检查抓的是一个非常隐蔽的坏法：dispatchTool 用 try/catch 包住调用，
// 方法名一旦对不上，只会返回一句「工具报错了」——模型和人都看不出真因。
// （这里曾经真的坏过：六个工具里有五个的方法名与分发表不一致，全部失效。）
{
  const proto = tools.ToolState.prototype;
  const toolNames = Object.keys(tools.TOOL_PARAMS);
  const missing = toolNames.filter((n) => typeof proto[n] !== 'function');

  // 反向检查：声明给模型的工具、与分发表里的工具，必须是同一批
  const declared = tools.TOOL_SPECS.map((s) => s.name).sort();
  const dispatchable = toolNames.slice().sort();
  const declaredNotDispatchable = declared.filter((n) => !dispatchable.includes(n));
  const dispatchableNotDeclared = dispatchable.filter((n) => !declared.includes(n));

  ok(missing.length === 0, `分发表里的工具在 ToolState 上没有同名方法：${missing.join('、')}`);
  ok(declaredNotDispatchable.length === 0, `声明了但无法分发的工具：${declaredNotDispatchable.join('、')}`);
  ok(dispatchableNotDeclared.length === 0, `可分发但没声明给模型的工具：${dispatchableNotDeclared.join('、')}`);

  line(`C0 工具清单一致性：${toolNames.length} 个工具，` +
    `${missing.length || declaredNotDispatchable.length || dispatchableNotDeclared.length ? '存在错位 ✗' : '声明 / 分发 / 实现三者一致 ✓'}`);
  line(`      ${toolNames.join('、')}`);
}

// C1 模型编造一个动作 id
{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    { action_id: 'install_cuda_13', title: 'x', detail: 'y', classification: 'environment', confidence: 0.9 },
    st,
  );
  ok(Boolean(out.error), 'C1: 模型编造 action_id 时工具未返回错误');
  ok(st.actions.length === 0, 'C1: 模型编造 action_id 时仍然登记了建议');
  ok(Array.isArray(out.available_actions) && out.available_actions.length > 0, 'C1: 未回传可用动作清单');
  line(`C1 编造 id「install_cuda_13」→ 拒绝并回传 ${out.available_actions.length} 条候选 ${out.error ? '✓' : '✗'}`);
}

// C2 ★ 模型试图自己声明风险等级
{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    {
      action_id: 'file_rma',
      risk: 'low', // ← 模型硬说这是低风险
      risk_label: '低风险',
      title: '重启一下就好',
      detail: '先重启看看',
      classification: 'hardware',
      confidence: 0.6,
    },
    st,
  );
  const a = st.actions[0];
  ok(Boolean(a), 'C2: 合法 action_id 未被登记');
  ok(a && a.risk === 'high', `C2: 模型传入的 risk 覆盖了库里的等级（实际 ${a && a.risk}）`);
  ok(a && a.risk_label === '高风险', `C2: 风险标签不是库里的值（实际 ${a && a.risk_label}）`);
  ok(
    a && typeof a.approval_requirement === 'string' && a.approval_requirement.includes('变更单号'),
    'C2: 高风险动作的审批要求未带上「变更单号」',
  );
  line(`C2 模型声明 risk=low 但选用 file_rma → 系统判定 ${a.risk} / ${a.risk_label} ${a.risk === 'high' ? '✓' : '✗'}`);
  line(`      该动作的命令与回滚来自动作库，模型无法改写：`);
  line(`      ${a.cmds[0]}`);
  line(`      回滚：${String(a.rollback).slice(0, 56)}…`);
}

// C3 被标记「不建议」的动作不得被选用
{
  const st = freshState();
  const out = await tools.dispatchTool(
    'propose_fix',
    { action_id: 'raise_nccl_timeout', title: 'x', detail: 'y', classification: 'network', confidence: 0.5 },
    st,
  );
  ok(Boolean(out.error), 'C3: 被标记不建议的动作竟然被接受了');
  ok(st.actions.length === 0, 'C3: 被标记不建议的动作仍然被登记');
  line(`C3 选用 raise_nccl_timeout → 拒绝 ${out.error ? '✓' : '✗'}`);
}

// C4 引用编号白名单：编造的 ref 必须被丢弃
{
  const st = freshState();
  await tools.dispatchTool('lookup_xid', { code: 94 }, st); // 产生 T1
  const out = await tools.dispatchTool(
    'propose_fix',
    {
      action_id: 'gpu_reset',
      title: '复位',
      detail: '复位该卡',
      classification: 'hardware_watch',
      confidence: 0.5,
      evidence_refs: ['T1', 'T99'],
    },
    st,
  );
  const a = st.actions[0];
  ok(Array.isArray(a.evidence_refs) && a.evidence_refs.includes('T1'), 'C4: 合法引用被误删');
  ok(!a.evidence_refs.includes('T99'), 'C4: 不存在的引用 T99 未被丢弃');
  ok(Boolean(out.warning), 'C4: 丢弃引用时未给出警告');
  line(`C4 引用 [T1, T99] → 保留 ${JSON.stringify(a.evidence_refs)}，丢弃 T99 ${out.warning ? '✓' : '✗'}`);
}

// C5 ★★ 执行层的审批门槛：模型不能通过 execute_action 绕过审批
{
  const st = freshState();
  const out = await tools.dispatchTool(
    'execute_action',
    { node: 'lyg2112', action_id: 'gpu_reset', reason: '复位试试' },
    st,
  );
  ok(out.refused === true, 'C5: 中风险动作 gpu_reset 未被拒绝');
  ok(/审批/.test(out.error || ''), 'C5: 拒绝理由里没说清需要人工审批');
  ok(Array.isArray(out.allowed_to_execute_now), 'C5: 未告诉模型哪些动作可以自主执行');
  line(`C5 模型要求执行 gpu_reset（中风险）→ ${out.refused ? '被拒绝 ✓' : '竟然放行 ✗'}`);
  line(`      ${String(out.error).slice(0, 86)}`);
}

// C6 高风险同样拦，并把它引导到 propose_fix
{
  const st = freshState();
  const out = await tools.dispatchTool(
    'execute_action',
    { node: 'lyg2112', action_id: 'file_rma', reason: '直接报修' },
    st,
  );
  ok(out.refused === true, 'C6: 高风险动作 file_rma 未被拒绝');
  ok(/propose_fix/.test(out.instead || ''), 'C6: 未把模型引导到 propose_fix 走审批');
  line(`C6 模型要求执行 file_rma（高风险）→ ${out.refused ? '被拒绝 ✓' : '竟然放行 ✗'}`);
}

// C7 没接集群时必须如实说「没连接」，不能假装成功
{
  const st = freshState();
  const ex = await tools.dispatchTool(
    'execute_action', { node: 'lyg2112', action_id: 'cordon_node', reason: 'x' }, st,
  );
  const sc = await tools.dispatchTool('scan_cluster', {}, st);
  ok(ex.executed !== true, 'C7: 未连接集群时 execute_action 竟然报告执行成功');
  ok(Boolean(ex.error), 'C7: 未连接集群时 execute_action 未给出错误');
  ok(Boolean(sc.error), 'C7: 未连接集群时 scan_cluster 未给出错误');
  line(`C7 未连接集群时执行/巡检 → 如实报错 ${ex.error && sc.error ? '✓' : '✗'}`);
}

// ======================================================================
rule('D. 案例库结构');
// ======================================================================
const ids = new Set();
for (const c of allCases) {
  ok(!ids.has(c.id), `案例 id 重复：${c.id}`);
  ids.add(c.id);
  ok(Boolean(c.expected), `${c.id}: 缺 expected`);
  if (c.expected) {
    ok(Object.hasOwn(kb.CLASSES, c.expected.class), `${c.id}: expected.class 非法（${c.expected.class}）`);
    ok(typeof c.expected.should_rma === 'boolean', `${c.id}: expected.should_rma 不是布尔值`);
    ok(Boolean(c.expected.trap), `${c.id}: 缺 trap（这一题最容易误判成什么）`);
    ok(Boolean(c.expected.root_cause), `${c.id}: 缺 root_cause`);
  }
}

/**
 * 成对对照：**刻意写死 id 而不是用正则去猜**。
 * 用正则匹配「driver」曾经把 case-driver-old（驱动太老）也算进了「驱动掉了」那一组，
 * 于是「成对」这个性质看起来成立、实际上是错的——分组错了，演示时的对照就站不住。
 */
const PAIRS = {
  '同码不同结论（Xid 94）': ['case-xid94-single', 'case-xid94-rising'],
  '驱动掉了（同一句报错，结论相反）': ['case-driver-nvml-mismatch', 'case-smi-driver-dead'],
  'GPU 卡死（症状相同，方向相反）': ['case-gpu-hang-xid62', 'case-gpu-hang-deadlock'],
};
for (const [name, list] of Object.entries(PAIRS)) {
  for (const id of list) ok(ids.has(id), `成对对照「${name}」引用了不存在的案例 ${id}`);
  ok(list.length >= 2, `成对对照「${name}」少于 2 个案例，演示价值不足`);
}

const byClass = {};
for (const c of allCases) byClass[c.expected.class] = (byClass[c.expected.class] || 0) + 1;
const rmaYes = allCases.filter((c) => c.expected.should_rma).length;

line(`案例总数：${allCases.length}　需要报修：${rmaYes} 个　不需要报修：${allCases.length - rmaYes} 个`);
line(`分类分布：${Object.entries(byClass).map(([k, v]) => `${kb.CLASSES[k].short || k} ${v}`).join('　')}`);
line(`成对对照（演示资产）：`);
for (const [name, list] of Object.entries(PAIRS)) {
  line(`  · ${name}`);
  line(`    ${list.join('  vs  ')}`);
}

// ======================================================================
rule('E. ★ F8 基准：纯规则路径实测');
// ======================================================================
line('规则基线 = 取预分析投票最高的分类，分类为 hardware 即建议报修。');
line('不读趋势、不辨因果链——这是设计上就做不到的，如实报告。\n');

const baselineRows = [];
for (const c of allCases) {
  const ev = triage.normalizeEvidence(c);
  const pre = triage.preAnalyze(ev);
  const r = triage.ruleBasedTriage(ev, pre);
  const cmp = triage.compareWithExpected(r, c.expected);
  baselineRows.push({ case: c, pre, rule: r, cmp });
}

const passCount = baselineRows.filter((r) => r.cmp.pass).length;
const classPass = baselineRows.filter((r) => r.cmp.class_ok).length;
const rmaPass = baselineRows.filter((r) => r.cmp.rma_ok).length;

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

line(`${pad('案例', 34)}${pad('期望', 18)}${pad('规则给出', 18)}结果`);
line('─'.repeat(88));
for (const r of baselineRows) {
  const want = `${r.case.expected.class}${r.case.expected.should_rma ? ' +报修' : ''}`;
  const got = `${r.rule.class}${r.rule.should_rma ? ' +报修' : ''}`;
  line(`${pad(r.case.id, 34)}${pad(want, 18)}${pad(got, 18)}${r.cmp.pass ? '对' : '✗ 错'}`);
}

line('');
line(`规则基线准确率（分类 + 是否报修全对）：${passCount} / ${allCases.length}` +
  `　（${((100 * passCount) / allCases.length).toFixed(1)}%）`);
line(`  仅看分类：${classPass} / ${allCases.length}　仅看是否报修：${rmaPass} / ${allCases.length}`);

const wrong = baselineRows.filter((r) => !r.cmp.pass);
if (wrong.length) {
  line('');
  line('规则错在哪几题、为什么会错：');
  for (const r of wrong) {
    const detail = [
      `分类 ${r.cmp.got.class} ≠ 期望 ${r.cmp.want.class}`,
      r.cmp.rma_ok ? null : `报修 ${r.cmp.got.should_rma} ≠ 期望 ${r.cmp.want.should_rma}`,
    ].filter(Boolean).join('；');
    line(`  · ${r.case.id}：${detail}`);
    line(`    规则看到的证据：${r.rule.basis.join('、') || '（无匹配证据）'}`);
    line(`    它读不出的东西：${r.case.expected.trap || '（未标注）'}`);
  }
}

// 三段证据的一致性检查：规则真的没在偷偷读趋势
line('');
line('（自证）基线的确只用了「最高票分类」这一个依据：');
for (const r of baselineRows.slice(0, 3)) {
  line(`  · ${r.case.id} → 依据「${r.rule.basis[0] || '无'}」`);
}

// ======================================================================
rule(failures.length ? `自检未通过：${failures.length} 项` : '自检全部通过');
// ======================================================================
for (const f of failures) line(`  ✗ ${f}`);
if (!failures.length) {
  line('动作库不变量、审批门槛、风险等级防绕过、案例库结构：全部符合预期。');
}
line('');
line(`F8 基准（实测，可直接写入 deck）：规则基线 ${passCount}/${allCases.length}，` +
  `AI 分诊结果见线上页面。`);
line('');

process.exit(failures.length ? 1 : 0);
