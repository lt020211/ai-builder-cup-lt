/**
 * AI 决策层：让 Gemini 先调用工具取数，再基于工具返回值给出可执行决策。
 *
 * 本文件是 src/ai.py 的浏览器端移植，后端换成 **Firebase AI Logic**
 * （端点 firebasevertexai.googleapis.com），密钥由平台托管，因此应用可以是
 * 纯静态站点、直接托管在 Firebase Hosting 上。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么不用 Firebase AI Logic 的官方 JS SDK（这是踩坑后的结论）
 * ────────────────────────────────────────────────────────────────────────
 * SDK 的 ChatSession 把工具结果回传的角色**写死为 `role: "function"`**，
 * 而新版模型已不接受这个角色，服务端会报：
 *     400 Role 'function' is not supported. Please use a valid role:
 *         SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, ... MODEL
 * 更麻烦的是：SDK 内部还做了一层客户端校验
 *     Content with role 'user' can't contain 'functionResponse' part
 * 于是「改用 role:'user' 回传」这条正确地路也被 SDK 挡住了。
 *
 * 实测（2026-10-14，见 scripts/probe_tool_roundtrip.py）：
 *     回传角色 = "function"  → 仅 gemini-3.1-flash-lite 还能兼容，其余全 400
 *     回传角色 = "user"      → gemini-3.5-flash-lite / 3.5-flash / 3.1-flash-lite 全部通过
 * 所以这里直接打 REST，自己控制 contents 的角色——顺带让逻辑与 Python 参考实现
 * 保持 1:1，也省掉了 150KB 的 SDK 依赖。
 *
 * 代价：暂时不带 App Check 令牌（该强制要求 2026-11-02 才生效，晚于本次赛事）。
 * 如需开启，应在请求头附加 App Check token，其余逻辑不变。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 与「读一段数字然后写一段话」的区别
 * ────────────────────────────────────────────────────────────────────────
 *   1. AI 必须通过 `query_metrics` 拿数据，数字不能自己编；
 *   2. 涉及碳排的结论必须先跑 `simulate_defer` / `estimate_carbon`；
 *   3. 每条建议必须用 `propose_action` 登记，前端据此渲染「接受 / 拒绝」按钮——
 *      交互从「看报告」变成「做决策」。
 *
 * 设计原则：失败绝不抛到界面，一律降级为离线规则模板（与在线模式同构的 actions）。
 */

import * as carbon from './carbon.js';
import { TOOL_SPECS, ToolState, dispatchTool } from './tools.js';
import { DIAGNOSE_PROMPT } from './prompt.js';

// ---------------------------------------------------------------- Firebase
/**
 * Firebase Web 配置。这些值**本来就设计为公开**（会出现在任何 Firebase 网页的
 * 源码里），真正的保护是安全规则与 App Check，不是把这串配置藏起来。
 */
export const FIREBASE_CONFIG = {
  projectId: 'gpu-waste-auditor-2026',
  appId: '1:164243643676:web:b6efb139223b48c8a8aed9',
  storageBucket: 'gpu-waste-auditor-2026.firebasestorage.app',
  apiKey: 'AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo',
  authDomain: 'gpu-waste-auditor-2026.firebaseapp.com',
  messagingSenderId: '164243643676',
};

/**
 * 模型降级链。每个模型有独立的免费日配额，前一个用不了就换下一个。
 *
 * 2026-10-14 实测（AI Logic / Gemini Developer API 后端，
 * 判定标准为「两个回合的工具调用往返都成功且第 2 回合有文本结论」）：
 *
 *   gemini-3.5-flash-lite   ✅ 完整往返  3.9s   零思考 token  ← 默认
 *   gemini-3.5-flash        ✅ 完整往返  5.8s
 *   gemini-3.1-flash-lite   ✅ 完整往返 19.1s
 *   gemini-3.8-flash        ⏸ 当日配额已用尽，未测出往返；作为能力兜底放最后
 *
 * 注意只测「模型能否发出 functionCall」是不够的：gemini-3.5-flash-lite
 * 能发，但用 role:"function" 回传就会被拒。判据必须是完整往返。
 */
export const MODEL_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
];

export const DEFAULT_MODEL = MODEL_CHAIN[0];

const ENDPOINT = (model) =>
  `https://firebasevertexai.googleapis.com/v1beta/projects/${FIREBASE_CONFIG.projectId}` +
  `/models/${model}:generateContent`;

/** 单次模型请求的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 90_000;

/** 工具调用循环的上限。免费层配额有限，回合越多越容易触发限流。 */
const MAX_TOOL_TURNS = 6;

/** 每分钟限流时的重试次数与默认等待（秒）。 */
const MAX_RETRIES = 2;
const RETRY_DEFAULT_WAIT_SEC = 15.0;

/** 若建议等待时间超过这个阈值，判定为「当日配额耗尽」，直接换模型而不是干等。 */
const LONG_WAIT_THRESHOLD_SEC = 90.0;

/**
 * 工具结果的回传角色。
 *
 * ★ 必须是 "user"：新版模型不接受 "function"，见文件头说明。
 * 单独提成常量，是为了让这个来之不易的结论在代码里显眼。
 */
const FUNCTION_RESPONSE_ROLE = 'user';

// ---------------------------------------------------------------- 提示词
/**
 * 把审计数据填进提示词模板。
 *
 * 除了三段 JSON，还额外算好两件事填进去：电耗最大的节点名、全天碳强度最低的小时。
 * 原因是实测发现：只说「挑电耗最大的节点调 simulate_defer」，模型会改用
 * estimate_carbon 自己算，于是「碳感知调度」这条建议就丢了；把节点名与目标小时
 * 直接写死在指令里，命中率才稳定。这两个值都由确定性代码算出，不涉及编造。
 */
export function buildPrompt(summary, findings, records = []) {
  const dump = (v) => JSON.stringify(v, null, 2);

  const heaviest = findings.length
    ? findings.reduce((best, f) =>
        (f.workload_energy_kwh || 0) > (best.workload_energy_kwh || 0) ? f : best,
      )
    : null;

  return DIAGNOSE_PROMPT.replace('{summary_json}', dump(summary))
    .replace('{findings_json}', dump(findings))
    .replace('{records_json}', dump(records))
    .replace('{heaviest_node}', heaviest ? heaviest.node : '（无，找不到有效节点）')
    .replace(
      '{heaviest_energy}',
      heaviest ? String(Math.round(heaviest.workload_energy_kwh || 0)) : '0',
    )
    .replace('{best_hour}', String(carbon.bestHour()));
}

// ---------------------------------------------------------------- 错误解析
/** 带 HTTP 状态的错误，便于上层判定是否限流。 */
export class ApiError extends Error {
  constructor(status, bodyText) {
    super(bodyText || `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = status;
    this.body = bodyText || '';
  }
}

/**
 * 把任意异常整理成可判定的信息。
 *
 * 为什么要自己解析：429 有两种截然不同的含义——
 *   「每分钟请求数超了」→ 等几十秒重试同一个模型即可；
 *   「当日免费额度用尽」→ 消息里会写 retry in 18h44m，干等等于卡死界面，必须换模型。
 */
export function describeError(err) {
  const text =
    err && err.body
      ? err.body
      : [err && err.name, err && err.code, err && err.message]
          .filter(Boolean)
          .join(' | ') || String(err);

  const isQuota =
    /\b429\b/.test(text) ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /quota exceeded/i.test(text) ||
    /rate.?limit/i.test(text);

  return { text, isQuota, retrySeconds: parseRetrySeconds(text) };
}

/** 从错误文本里解析服务端建议的重试等待秒数；支持 "18h44m1.4s" 与 "2.3s" 两种写法。 */
export function parseRetrySeconds(text) {
  const hms = text.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?([0-9.]+)s/i);
  if (hms) {
    const [, h, m, s] = hms;
    return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
  }
  const plain = text.match(/retry in\s+([0-9.]+)\s*s/i);
  if (plain) return Number(plain[1]);
  const delay = text.match(/"?retryDelay"?\s*[:=]\s*"?([0-9.]+)s/i);
  if (delay) return Number(delay[1]);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 网络
/**
 * POST 到 AI Logic 的 generateContent。
 *
 * 几个必须踩对的点：
 *   - 鉴权只能用 **header** `x-goog-api-key`；用查询参数 `?key=` 会被边缘直接
 *     返回 HTML 400（看起来像模型不存在，极易误判）。
 *   - 用 AbortController 做超时，思考模型单回合可能十几秒。
 */
async function postGenerateContent(model, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': FIREBASE_CONFIG.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(res.status, `响应不是合法 JSON：${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError(0, `请求超时（${timeoutMs / 1000}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 工具调用循环：模型 → 工具 → 模型 → … → 最终文本。
 *
 * contents 的拼装规则（这是整个链路最容易错的地方）：
 *   用户提示            → { role: 'user',  parts: [{ text }] }
 *   模型发起的工具调用  → { role: 'model', parts }   ← **原样回传**，
 *                          因为思考模型返回的 thoughtSignature 必须保持不动
 *   工具结果            → { role: 'user',  parts: [{ functionResponse }] }
 *                          角色是 user 而不是 function，理由见文件头
 */
async function agenticDiagnose({ summary, findings, records, modelName, onProgress }) {
  const state = new ToolState(records, findings, summary);
  const contents = [
    { role: 'user', parts: [{ text: buildPrompt(summary, findings, records) }] },
  ];
  const toolCalls = [];

  const notify = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  notify('已把审计数据交给模型，等待它发起工具调用…');

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const data = await postGenerateContent(modelName, {
      contents,
      tools: [{ functionDeclarations: TOOL_SPECS }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    });

    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      const blocked = data.promptFeedback?.blockReason;
      throw new ApiError(
        0,
        blocked ? `请求被安全策略拦截：${blocked}` : '模型响应中没有 candidates',
      );
    }

    const parts = (candidates[0].content || {}).parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (calls.length > 0) {
      contents.push({ role: 'model', parts });

      const responses = calls.map((call) => {
        const name = call.name || '';
        const args = call.args || {};
        toolCalls.push({ name, args });
        notify(`工具 ${name}(${JSON.stringify(args)})`);
        const result = dispatchTool(name, args, state);

        const functionResponse = { name, response: { result } };
        // 新版 API 会给 functionCall 带 id，成对回传更稳妥
        if (call.id) functionResponse.id = call.id;
        return { functionResponse };
      });

      notify(`收到 ${calls.length} 次工具调用，回传结果…`);
      contents.push({ role: FUNCTION_RESPONSE_ROLE, parts: responses });
      continue;
    }

    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    if (text) {
      return {
        mode: 'gemini',
        model: modelName,
        text,
        actions: state.actions,
        tool_calls: toolCalls,
      };
    }

    const finish = candidates[0].finishReason;
    throw new ApiError(
      0,
      `模型既没有调用工具，也没有产出文本（finishReason=${finish}）`,
    );
  }

  throw new ApiError(0, `连续 ${MAX_TOOL_TURNS} 轮只调用工具，未产出最终结论`);
}

/**
 * 在降级链上依次尝试模型。
 *
 * 返回 { failures } 表示所有模型都失败，调用方应降级为离线模板。
 */
async function tryModelChain({ summary, findings, records, onProgress }) {
  const failures = [];

  for (const modelName of MODEL_CHAIN) {
    let attempts = 0;
    // 同一个模型上，只因「短时限流」而重试；长等待或其它错误就换下一个模型
    while (attempts <= MAX_RETRIES) {
      try {
        const out = await agenticDiagnose({
          summary,
          findings,
          records,
          modelName,
          onProgress,
        });
        // 把「为什么换了模型」一并带出去：界面上要能看到具体原因，
        // 否则一旦某个模型在浏览器里被拒，就只能靠猜（踩过这个坑）。
        if (failures.length) out.degraded = failures;
        return out;
      } catch (err) {
        const info = describeError(err);
        // 同时打到控制台，便于用 DevTools 复盘原始报错
        console.warn(`[ai] 模型 ${modelName} 调用失败：`, info.text);

        if (info.isQuota) {
          const waitSec = info.retrySeconds ?? RETRY_DEFAULT_WAIT_SEC;
          if (waitSec <= LONG_WAIT_THRESHOLD_SEC && attempts < MAX_RETRIES) {
            attempts += 1;
            if (typeof onProgress === 'function') {
              onProgress(`触发限流，等待 ${Math.ceil(waitSec)}s 后重试 ${modelName}…`);
            }
            await sleep((waitSec + 1) * 1000);
            continue;
          }
          failures.push({
            model: modelName,
            reason: waitSec > LONG_WAIT_THRESHOLD_SEC
              ? `当日免费额度已用尽（约 ${Math.round(waitSec / 3600)} 小时后再可用）`
              : `限流重试 ${MAX_RETRIES} 次仍失败`,
          });
          break;
        }

        failures.push({ model: modelName, reason: info.text.slice(0, 240) });
        break;
      }
    }
  }

  return { failures };
}

// ---------------------------------------------------------------- 离线降级
/** 不依赖模型，用规则产出与在线模式同构的结构化建议。 */
export function offlineActions(findings) {
  const totals = {};
  const carbonByPattern = {};
  for (const item of findings) {
    const pattern = item.dominant_pattern || 'unknown';
    totals[pattern] = (totals[pattern] || 0) + Number(item.waste_cost_cny || 0);
    carbonByPattern[pattern] =
      (carbonByPattern[pattern] || 0) + Number(item.waste_carbon_kg || 0);
  }

  const catalog = {
    idle: [
      '空转节点自动回收',
      '对利用率持续低于 5% 的节点加 TTL，到期自动释放回资源池。',
      '中',
    ],
    over_request: [
      '回收超额预留',
      '把申请卡数下限与实测峰值用量对齐，砍掉全程占位的空卡。',
      '低',
    ],
    low_util: [
      '低效任务配额重分配',
      '对利用率长期低于 30% 的任务做配额重分配或合并到同一节点。',
      '中',
    ],
  };

  const actions = [];
  const ordered = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  for (const [pattern, amount] of ordered) {
    const entry = catalog[pattern];
    if (!entry) continue;
    actions.push({
      id: `A${actions.length + 1}`,
      title: entry[0],
      detail: entry[1],
      expected_cost_recovery_cny: round2(amount),
      expected_carbon_reduction_kg: round2(carbonByPattern[pattern] || 0),
      effort: entry[2],
      evidence: `该模式合计浪费 ¥${Math.round(amount).toLocaleString('zh-CN')}`,
    });
  }

  // 碳感知建议：挑电耗最大的节点，算挪时段能省多少碳
  if (findings.length) {
    const heaviest = findings.reduce((best, f) =>
      (f.workload_energy_kwh || 0) > (best.workload_energy_kwh || 0) ? f : best,
    );
    if ((heaviest.workload_energy_kwh || 0) > 0) {
      const impact = carbon.deferImpact(
        heaviest.workload_energy_kwh,
        heaviest.start_hour ?? 19,
        carbon.bestHour(),
      );
      if (impact.carbon_reduction_kg > 0) {
        actions.push({
          id: `A${actions.length + 1}`,
          title: '把高耗节点挪到低碳时段',
          detail:
            `${heaviest.node} 当前在 ${impact.from_hour}:00 运行，` +
            `挪到 ${impact.to_hour}:00 电网碳强度更低` +
            `（${impact.intensity_from_kg_per_kwh} → ${impact.intensity_to_kg_per_kwh} kgCO2e/kWh），` +
            `电耗不变，碳排降 ${impact.carbon_reduction_pct}%。`,
          expected_cost_recovery_cny: 0.0,
          expected_carbon_reduction_kg: impact.carbon_reduction_kg,
          effort: '中',
          evidence: `${heaviest.node} 周期电耗 ${Math.round(heaviest.workload_energy_kwh).toLocaleString('zh-CN')} kWh`,
        });
      }
    }
  }
  return actions;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 生成离线四段式诊断文本。 */
export function offlineDiagnosis(summary, findings, actions = null) {
  const acts = actions || offlineActions(findings);
  const top = findings.slice(0, 3);
  const L = [];
  const n0 = (v) => Math.round(v).toLocaleString('zh-CN');
  // 对齐 Python 的 f"{v:,.1f}"——必须同时固定最少与最大小数位，否则 63.03 会显示成
  // 「63」而 Python 显示「63.0」，差分测试会报不一致。
  const n1 = (v) =>
    Number(v).toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

  L.push('### 1. 浪费画像');
  L.push(
    `本批次共审计 ${summary.record_count} 条算力记录，浪费卡时 ` +
      `${n0(summary.total_waste_card_hours)} 卡时，占预留卡时的 ` +
      `${n1(summary.waste_ratio_pct)}%，折合电费 ¥${n0(summary.total_waste_cost_cny)}、` +
      `碳排 ${n0(summary.total_waste_carbon_kg)} kgCO2e` +
      `（约合 ${n0(summary.carbon_tree_equivalent)} 棵成年树一年的固碳量）。`,
  );
  if (top.length) {
    const w = top[0];
    L.push(
      `浪费最集中的节点是 ${w.cloud} / ${w.node}（${w.gpu_type}，` +
        `模式：${w.pattern_label}），单项浪费 ¥${n0(w.waste_cost_cny)}。`,
    );
  }

  L.push('', '### 2. 根因推断（离线规则版）');
  for (const item of top) {
    let reason;
    if (item.dominant_pattern === 'over_request') {
      reason =
        `申请 ${item.requested_cards} 卡但实际仅用 ${item.used_cards} 卡，` +
        `差 ${item.requested_cards - item.used_cards} 卡全程占位未参与计算`;
    } else if (item.dominant_pattern === 'idle') {
      reason = `平均利用率仅 ${item.avg_util_pct}%，卡被占用但几乎不产出`;
    } else {
      reason = `平均利用率 ${item.avg_util_pct}%，低于 30% 的低效阈值`;
    }
    L.push(
      `- **${item.node}**（${item.gpu_type}）：${reason}，浪费 ` +
        `${n0(item.waste_card_hours)} 卡时 / ¥${n0(item.waste_cost_cny)}。此结论由数据直接确认。`,
    );
  }

  L.push('', '### 3. 优化动作（与下方决策清单一一对应）');
  acts.forEach((a, i) => {
    const benefit = [];
    if (a.expected_cost_recovery_cny > 0) benefit.push(`回收 ¥${n0(a.expected_cost_recovery_cny)}`);
    if (a.expected_carbon_reduction_kg > 0) {
      benefit.push(`减碳 ${n1(a.expected_carbon_reduction_kg)} kgCO2e`);
    }
    L.push(
      `${i + 1}. **${a.title}**（${benefit.join('、') || '收益待评估'}，` +
        `实施成本${a.effort}）：${a.detail}`,
    );
  });

  L.push('', '### 4. 需要补充的数据');
  L.push(
    '缺少显存利用率、任务队列等待时长、任务时限约束与卡型单价台账，' +
      '补齐后可将估算升级为逐任务归因，并判断哪些任务真的可以延后。',
  );
  L.push('', '> 本段为**离线规则模板**输出，未调用大模型。');
  return L.join('\n');
}

function fallback(mode, summary, findings, error, model = '') {
  const actions = offlineActions(findings);
  const out = {
    mode,
    text: offlineDiagnosis(summary, findings, actions),
    actions,
    tool_calls: [],
    error,
  };
  if (model) out.model = model;
  return out;
}

// ---------------------------------------------------------------- 入口
/**
 * 生成 AI 诊断，返回 {mode, text, actions, tool_calls, ...}。
 *
 * mode 三态：
 *   gemini   —— 模型自主调用工具生成（最佳）
 *   fallback —— 模型调用失败，已降级为离线模板
 *   offline  —— 未启用在线模式，直接用离线模板
 *
 * 无论哪条路径都不会抛异常，保证演示现场不崩。
 */
export async function diagnose({
  summary,
  findings,
  records = null,
  onProgress = null,
  enabled = true,
}) {
  const recs = records || findings;

  if (!enabled) {
    return fallback('offline', summary, findings, '未启用在线模式');
  }

  try {
    const result = await tryModelChain({ summary, findings, records: recs, onProgress });
    if (result && result.mode === 'gemini') return result;

    const reason = (result?.failures || [])
      .map((f) => `${f.model}: ${f.reason}`)
      .join('；');
    return fallback('fallback', summary, findings, reason || '所有模型均不可用');
  } catch (err) {
    const info = describeError(err);
    return fallback('fallback', summary, findings, info.text.slice(0, 300));
  }
}
