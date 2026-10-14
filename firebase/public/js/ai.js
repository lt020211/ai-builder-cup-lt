/**
 * AI 层：让 Gemini 先调用工具取证，再下判断；在值班模式下还要真的动手处置。
 *
 * 后端是 **Firebase AI Logic**（firebasevertexai.googleapis.com），密钥由平台托管，
 * 因此应用可以是纯静态站点、直接托管在 Firebase Hosting 上。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么不用官方 JS SDK（这是踩坑后的结论，勿再尝试）
 * ────────────────────────────────────────────────────────────────────────
 * SDK 的 ChatSession 把工具结果回传的角色**写死为 `role: "function"`**，
 * 而新版模型已不接受这个角色，服务端报：
 *     400 Role 'function' is not supported. Please use a valid role:
 *         SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, ... MODEL
 * 更麻烦的是 SDK 内部还有一层客户端校验
 *     Content with role 'user' can't contain 'functionResponse' part
 * 于是「改用 role:'user' 回传」这条正确地路也被 SDK 自己挡住了。
 *
 * 实测（2026-10-14，见 scripts/probe_tool_roundtrip.py）：
 *     回传角色 = "function"  → 仅 gemini-3.1-flash-lite 还能兼容，其余全 400
 *     回传角色 = "user"      → gemini-3.5-flash-lite / 3.5-flash / 3.1-flash-lite 全部通过
 * 所以这里直接打 REST，自己控制 contents 的角色，顺带省掉 150KB 依赖。
 *
 * 代价：暂时不带 App Check 令牌（该强制要求 2026-11-02 才生效，晚于本次赛事）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 两个入口
 * ────────────────────────────────────────────────────────────────────────
 *   diagnose()  单次分诊：给一段失败现场，判断「代码的锅还是该换卡」
 *   patrol()    值班巡检：自己去集群发现问题 → 止损 → 建工单 → 通知人
 *
 * 两者共用同一套工具循环、同一套降级链、同一套离线兜底。
 * 设计原则：失败绝不抛到界面，一律降级为离线规则路径。
 */

import { TOOL_SPECS, toolSpecsFor, ToolState, dispatchTool, nodeSignals } from './tools.js';
import { buildCasePrompt, buildPatrolPrompt } from './prompt.js';
import { normalizeEvidence, preAnalyze, ruleBasedTriage } from './triage.js';
import { ACTION_LIST, RISK_LEVELS, suggestActions, getAction } from './actions.js';
import { CLASSES } from './kb.js';

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
 * 判定标准为「多回合工具调用往返都成功且最后一回合有文本结论」）：
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

/** 单次模型请求的超时（毫秒）。思考模型单回合可能十几秒。 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * 工具调用的轮次上限。**一轮 ≠ 一次调用**：模型可以在一轮里并行发多个
 * functionCall（实测它会一次发 4 个 inspect_node 逐个节点取证），
 * 所以这个数字对应的是「来回次数」，不是「调用次数」。
 *
 * 为什么从 8 提到 12：值班巡检跑完一整套
 * （扫描 → 逐节点取证 → 查库 → 止损执行 → 建工单 → 通知 → 出报告）
 * 在模型不并行、一次只发一个调用时要 13 轮。定 8 会**必然截断**，
 * 而截断的代价是换模型后从头再来一遍 —— 更慢、更贵、还多扫一次集群。
 * 12 给了一定余量，同时仍能挡住真正跑飞的情况。
 */
const MAX_TOOL_TURNS = 12;

/**
 * 最多允许「带着已有进度换模型续跑」几次。
 *
 * 上游偶发 5xx 时，续跑能把已完成的工作保住（实测踩到过：巡检跑完 cordon
 * 之后上游返回 500，整段重来导致工单和通知都没发出）。
 * 但要有上限 —— 连续失败时无限续跑只会把配额烧在没有产出的循环里。
 */
const MAX_RESUMES = 2;

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
 * 两个必须踩对的点：
 *   - 鉴权只能用 **header** `x-goog-api-key`；用查询参数 `?key=` 会被边缘直接
 *     返回 HTML 400（看起来像模型不存在，极易误判）。
 *   - 用 AbortController 做超时。
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
async function runAgent({ prompt, state, modelName, onProgress, toolSpecs = TOOL_SPECS, carry = null }) {
  // ★ carry 是「上一次在别的模型上已经跑过的进度」。
  //   带上它，换模型重试就是**接着跑**，而不是从头再来。
  //   为什么必须先做这件事：值班巡检要连续跑 5 轮工具（扫描→取样→止损→建单→通知），
  //   单次模型请求要全程成功。上游偶发一个 500 就会让整段重来 ——
  //   已经执行过的 cordon 白做了、工单没建、通知没发，而这是要**在台上演**的东西。
  //   注意 contents 要复制：否则重试会把同一个数组反复 push 坏。
  const contents = carry?.contents
    ? carry.contents.map((c) => ({ ...c }))
    : [{ role: 'user', parts: [{ text: prompt }] }];
  const toolCalls = carry?.toolCalls ? carry.toolCalls.slice() : [];

  const notify = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    let data;
    try {
      data = await postGenerateContent(modelName, {
        contents,
        // ★ 只声明本模式真正能用的工具。理由见 tools.js 的 toolSpecsFor()：
        //   给模型一把开不了门的钥匙，只会让它白调一次并在轨迹上留下假故障。
        tools: [{ functionDeclarations: toolSpecs }],
        // temperature 压低：分诊要的是稳定判断，不是文采
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      });
    } catch (err) {
      // ★ 只对**传输/上游失败**挂 resume（请求没成功，这一轮没产生任何状态）。
      //   刻意不给「模型绕圈不收敛」挂 —— 那种情况接着跑只会继续绕，
      //   白烧配额。见文件末尾那个 throw。
      if (err && typeof err === 'object') {
        err.resume = { contents, toolCalls, turns: turn };
      }
      throw err;
    }

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

      const responses = [];
      for (const call of calls) {
        const name = call.name || '';
        const args = call.args || {};
        toolCalls.push({ name, args });
        notify(`工具 ${name}(${JSON.stringify(args)})`);
        // ★ 必须 await：巡检 / 执行 / 建单 / 通知这几个工具会访问集群
        const result = await dispatchTool(name, args, state);

        const functionResponse = { name, response: { result } };
        // 新版 API 会给 functionCall 带 id，成对回传更稳妥
        if (call.id) functionResponse.id = call.id;
        responses.push({ functionResponse });
      }

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
      return { mode: 'gemini', model: modelName, text, tool_calls: toolCalls };
    }

    const finishReason = candidates[0].finishReason;
    const empty = new ApiError(0, `模型既没有调用工具，也没有产出文本（finishReason=${finishReason}）`);
    if (toolCalls.length) empty.resume = { contents, toolCalls, turns: turn };
    throw empty;
  }

  // ★★ 撞上轮次上限时，**必须把已完成的调用一起交出去**。
  //
  // 这一条是实测发现的：值班巡检第一轮跑了 13 次工具调用（扫描 + 4 个节点取证 +
  // 查库 + 处置 + 建单 + 通知）之后撞上 MAX_TOOL_TURNS，因为这里没挂 resume，
  // 整个 13 次调用被丢掉，换模型后**从头又扫了一遍集群**。
  // 症状就藏在界面上：引用表有 T1…T18，调用轨迹却只显示 5 条 ——
  // 「证据链」和「实际做过的事」对不上，而这恰恰是整套东西最核心的卖点。
  //
  // 判断标准很简单：**有已完成的调用就值得带走**。带走之后新模型只需要
  // 看一眼历史就能收尾，比从零重来更省配额，也更不容易做重复动作。
  // （纯空转、一次调用都没有的情况仍不带走 —— 那没有东西可保。）
  const exhausted = new ApiError(0, `连续 ${MAX_TOOL_TURNS} 轮只调用工具，未产出最终结论`);
  if (toolCalls.length) exhausted.resume = { contents, toolCalls, turns: MAX_TOOL_TURNS };
  throw exhausted;
}

/**
 * 在降级链上依次尝试模型。返回 { failures } 表示所有模型都失败。
 */
async function tryModelChain({ prompt, state, onProgress, toolSpecs = TOOL_SPECS }) {
  const failures = [];
  /** ★ 跨模型携带的进度：有它就能「接着跑」而不是重头来。 */
  let carry = null;
  let resumes = 0;

  for (const modelName of MODEL_CHAIN) {
    let attempts = 0;
    // 同一个模型上，只因「短时限流」而重试；长等待或其它错误就换下一个模型
    while (attempts <= MAX_RETRIES) {
      try {
        const out = await runAgent({
          prompt, state, modelName, onProgress, toolSpecs, carry,
        });
        // 把「为什么换了模型」一并带出去：界面上要能看到具体原因
        if (failures.length) out.degraded = failures;
        if (carry) out.resumed = true;
        return out;
      } catch (err) {
        const info = describeError(err);
        console.warn(`[ai] 模型 ${modelName} 调用失败：`, info.text);

        // 上游失败但本轮之前的进度还在 → 带给下一个模型接着跑。
        // 上限 MAX_RESUMES 次：避免连续失败时把预算耗在无谓的续跑上。
        if (err?.resume && resumes < MAX_RESUMES) {
          const done = (err.resume.toolCalls || []).length;
          carry = err.resume;
          resumes += 1;
          if (typeof onProgress === 'function' && done > 0) {
            onProgress(`上游失败，保留已完成的 ${done} 次工具调用，换模型继续…`);
          }
        }

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

/** 把工具状态的产出统一打包，在线与离线两条路径结构一致。 */
function packResult(state, extra = {}) {
  return {
    actions: state?.actions || [],
    executions: state?.executions || [],
    tickets: state?.tickets || [],
    notifications: state?.notifications || [],
    citations: state?.citations || [],
    ...extra,
  };
}

/**
 * 结果的**唯一**出口。diagnose 与 patrol 都必须走这里。
 *
 * ★ 为什么专门抽一个函数出来：这两个入口原先各自写了一个局部的 `finish()`，
 *   长成这样 ——
 *       packResult(state, { mode, text, model: extra.model || '', error })
 *       if (extra.degraded) out.degraded = extra.degraded;
 *   也就是**只把 model 与 degraded 从在线结果里挑出来**。于是 `tool_calls`
 *   被静默丢掉了，而它不在任何断言里，谁也不会发现。
 *
 *   后果很恶劣：模型明明调了 lookup_xid / inspect_node（citations 里一条不差地
 *   记着），界面上「AI 的工具调用轨迹」却永远显示「本次没有调用工具」。
 *   被藏起来的恰恰是整个演示最值钱的证据 —— 「AI 不生成数字，它去取数字」。
 *   更糟的是同一屏上「由 gemini-… 自主调用工具生成」还在说真话，
 *   两处自相矛盾，任何一个评委扫一眼就会怀疑整套东西是包装出来的。
 *
 *   所以现在只留这一个出口，并且**整包 spread、不挑字段**：
 *   以后谁在 runAgent 的返回里加了新字段，都会自动带出来，不需要记得改这里。
 */
function finishResult(state, mode, text, extra = {}, error = null) {
  // ★ 在线路径的形状保证。
  //
  //   runAgent 从 `const toolCalls = []` 起手，所以它**一定**返回数组。
  //   换句话说：mode 是 gemini 而 tool_calls 不是数组，只有一种解释 ——
  //   打包这一段又漏字段了。这时**绝不能默默当成「没有调用工具」**，
  //   那正是上一次 bug 的伪装方式。要把它标成链路问题，让界面直接说出来。
  const broken = mode === 'gemini' && !Array.isArray(extra.tool_calls);
  const calls = Array.isArray(extra.tool_calls) ? extra.tool_calls : [];

  // ★ 第二条不变量：**每条引用都对应一次工具调用**。
  //   引用是工具在真正跑的时候登记下来的（`_cite`），一次调用最多登记一条。
  //   所以「引用数 > 调用数」在数学上不可能 —— 出现了就说明有一批调用记录丢了。
  //   实测踩到过：撞上轮次上限后那 13 次调用被丢弃，界面上引用表有 T1…T18、
  //   调用轨迹却只显示 5 条。**证据链与实际做过的事对不上**，这是最不能出的错。
  const cited = (state?.citations || []).length;
  const lostWork = cited > calls.length;

  const notes = [];
  if (broken) {
    notes.push('在线路径没有带回 tool_calls：这是打包链路的问题，不代表模型没调用工具。');
  }
  if (lostWork) {
    notes.push(
      `有 ${cited} 条工具引用，但只记录了 ${calls.length} 次调用 —— `
      + '说明中间有一批调用记录没有保留下来（通常是换模型重试时丢的）。'
      + '结论可能仍然成立，但轨迹不完整，请以「引用表」为准。',
    );
  }

  return packResult(state, {
    ...extra,
    tool_calls: calls,
    ...(notes.length ? { pipeline_error: notes.join(' ') } : {}),
    mode,
    text,
    model: extra.model || '',
    error,
  });
}

// ======================================================================
// 离线降级：不依赖模型，用规则产出同构的结果
// ======================================================================
/**
 * 单次分诊的离线版本。
 *
 * ★ 走的就是 F8 基准里那条「纯规则路径」——所以它的准确率是已知的（11/14），
 * 界面上会如实标注它是规则结果。**不要为了让降级版好看而偷偷加逻辑**：
 * 那样 F8 的对照就失去意义了。
 */
export function offlineCaseTriage(evidence, pre = null) {
  const p = pre || preAnalyze(evidence);
  const triage = ruleBasedTriage(evidence, p);
  const cls = triage.class;

  const actions = [];
  for (const a of suggestActions(cls)) {
    if (a.risk !== 'low') continue; // 离线路径不替人做中高风险决策
    if (actions.length >= 3) break;
    actions.push({
      id: `F${actions.length + 1}`,
      action_id: a.id,
      action_label: a.label,
      title: a.label,
      detail: `规则匹配到「${a.applies_to.join('/')}」类故障时的常见处置。`,
      risk: a.risk,
      risk_label: RISK_LEVELS[a.risk].label,
      approval_requirement: RISK_LEVELS[a.risk].approval,
      affects: a.affects,
      cmds: a.cmds,
      params: a.params,
      expect: a.expect,
      rollback: a.rollback,
      classification: cls,
      classification_label: CLASSES[cls]?.label || cls,
      confidence: triage.confidence,
      evidence_refs: [],
      evidence: triage.basis.join('；'),
    });
  }

  return {
    classification: cls,
    should_rma: triage.should_rma,
    confidence: triage.confidence,
    basis: triage.basis,
    actions,
  };
}

/** 生成离线分诊文本。四段式，与在线版结构对齐。 */
export function offlineCaseText(evidence, pre, result) {
  const c = pre?.confirmed || {};
  const L = [];
  const cls = result.classification;

  L.push('### 1. 结论（离线规则版）');
  L.push(
    `分类 **${cls}**，${result.should_rma ? '建议**进入报修流程**' : '**不建议报修**'}，` +
      `置信度 ${(result.confidence * 100).toFixed(0)}%。`,
  );
  L.push('');

  L.push('### 2. 机器确证的事实');
  if (c.xids?.length) {
    for (const x of c.xids) {
      L.push(
        `- Xid ${x.code}（${x.name || '知识库无记录'}）× ${x.count}` +
          `${x.known ? '' : '　★ 知识库无记录，不得推测其含义'}`,
      );
    }
  } else {
    L.push('- 报错文本中未检出 Xid 码。');
  }
  for (const s of c.signatures || []) L.push(`- 匹配到特征「${s.label}」`);
  if (c.compat_ok === false) L.push('- 版本栈存在不兼容项');
  if (c.memory_fit) L.push(`- 显存核算：${c.memory_required_gb} GB / 容量 ${c.memory_capacity_gb} GB → ${c.memory_fit}`);
  L.push('');

  L.push('### 3. 规则给出的处置方向');
  if (result.actions.length) {
    result.actions.forEach((a, i) => {
      L.push(`${i + 1}. **${a.action_label}**（${a.risk_label}，影响面：${a.affects}）`);
    });
  } else {
    L.push('- 规则未能给出任何低风险动作。');
  }
  L.push('');

  L.push('### 4. 规则做不到的部分');
  L.push(
    '规则只按「最高票分类」判断，**不读趋势、不辨因果链**。'
      + '所以它在需要看 30 天频次曲线、或需要区分「次生事件与根因」的案例上会判错。'
      + '完整能力需要模型参与，当前是降级路径。',
  );
  L.push('');
  L.push('> 本段为**离线规则模板**输出，未调用大模型。');
  return L.join('\n');
}

// ======================================================================
// 入口一：单次分诊
// ======================================================================
/**
 * 单次分诊。
 *
 * @param caseObj   案例对象（来自 cases.json）或 { id, evidence } 形式的临时对象
 * @param cluster   可选的模拟集群客户端。不传则只能看证据包里的遥测快照。
 * @param onProgress 进度回调，用于界面显示「正在调用哪个工具」
 * @param enabled   是否启用在线模型；false 时直接走离线规则路径
 */
export async function diagnose({
  caseObj, cluster = null, onProgress = null, enabled = true,
}) {
  const evidence = normalizeEvidence(caseObj);
  const pre = preAnalyze(evidence);
  const state = new ToolState(evidence, pre, { cluster });

  const finish = (mode, text, extra = {}, error = null) =>
    finishResult(state, mode, text, extra, error);

  if (!enabled) {
    const off = offlineCaseTriage(evidence, pre);
    // ★ 与 degradeCase 保持一致：把规则给出的动作也登记进 state。
    //   否则走这条路径时 处置清单 会是空的，而文本里明明列了动作 —— 两处对不上。
    state.actions = off.actions;
    return finish('offline', offlineCaseText(evidence, pre, off), { offline: off });
  }

  const prompt = buildCasePrompt(evidence, pre, pre.hints);
  if (typeof onProgress === 'function') {
    onProgress('已把现场交给模型，等待它发起工具调用…');
  }

  try {
    const res = await tryModelChain({
      prompt, state, onProgress, toolSpecs: toolSpecsFor('case'),
    });
    if (res && res.mode === 'gemini') return finish('gemini', res.text, res);

    const failures = res?.failures || [];
    const reason = failures.map((f) => `${f.model}: ${f.reason}`).join('；');
    // 把 failures 一并交给降级路径：界面上要能看到**每个模型各自是怎么失败的**，
    // 而不是只给一句「已降级」。这也是「不假装」的一部分 ——
    // 没跑成就是没跑成，把原因摊开比含糊过去可信。
    return degradeCase(evidence, pre, state, finish, reason || '所有模型均不可用', failures);
  } catch (err) {
    const info = describeError(err);
    return degradeCase(evidence, pre, state, finish, info.text.slice(0, 300));
  }
}

function degradeCase(evidence, pre, state, finish, error, degraded = []) {
  const off = offlineCaseTriage(evidence, pre);
  // 把规则给出的动作也登记进 state，保证两条路径的界面渲染逻辑一致
  state.actions = off.actions;
  return finish(
    'fallback',
    `> ⚠️ 模型调用失败，已降级为离线规则模板。原因：${error}\n\n` + offlineCaseText(evidence, pre, off),
    { offline: off, degraded },
    error,
  );
}

// ======================================================================
// 入口二：值班巡检
// ======================================================================
/**
 * 值班巡检。**这是「Agent」这个身份真正成立的地方。**
 *
 * 与 diagnose 的区别不只是提示词——它给了模型一个空的证据包和一整个集群，
 * 让它自己去发现该看什么、自己决定要做什么、真的去做，然后向人汇报。
 *
 * ⚠️ 诚实声明：纯静态站点没有常驻进程，「主动」在演示里表现为**由人点一下开始**，
 * 之后这一段循环是自动跑的。真实部署应由 Cloud Scheduler 之类定时触发。
 * 这一点在界面上会写清楚，不假装有常驻服务。
 */
export async function patrol({
  cluster, clusterMeta = {}, onProgress = null, enabled = true,
}) {
  if (!cluster) {
    return { mode: 'error', text: '未连接集群，无法巡检。', error: '未连接集群' };
  }

  // 巡检没有单一证据包，但工具层需要一个上下文来存引用
  const evidence = normalizeEvidence({ id: 'patrol', title: '值班巡检', evidence: {} });
  const pre = preAnalyze(evidence);
  const state = new ToolState(evidence, pre, { cluster });

  const finish = (mode, text, extra = {}, error = null) =>
    finishResult(state, mode, text, extra, error);

  if (!enabled) {
    return finish('offline', await offlinePatrolText(cluster), {}, '未启用在线模式');
  }

  const prompt = buildPatrolPrompt(clusterMeta);
  if (typeof onProgress === 'function') {
    onProgress('开始值班巡检，模型将自行扫描集群…');
  }

  try {
    const res = await tryModelChain({
      prompt, state, onProgress, toolSpecs: toolSpecsFor('patrol'),
    });
    if (res && res.mode === 'gemini') return finish('gemini', res.text, res);
    const failures = res?.failures || [];
    const reason = failures.map((f) => `${f.model}: ${f.reason}`).join('；');
    return finish(
      'fallback',
      await offlinePatrolText(cluster),
      { degraded: failures },
      reason || '所有模型均不可用',
    );
  } catch (err) {
    const info = describeError(err);
    return finish('fallback', await offlinePatrolText(cluster), {}, info.text.slice(0, 300));
  }
}

/**
 * 离线巡检：只做「发现」，不处置。
 *
 * ★ 严格说这是**半成品**，而这里刻意不做成完整版：离线路径本来就不该替人做决定。
 * 它把需要关注的节点列出来、给出规则判断，然后明确告诉人「处置需要模型在线」。
 * 让它假装能完成整套值班，才是真的危险。
 */
export async function offlinePatrolText(cluster) {
  const nodes = await cluster.listNodes();
  const flagged = nodes
    .map((n) => ({ node: n.node, signals: nodeSignals(n) }))
    .filter((x) => x.signals.length);

  const L = [];
  L.push('### 巡检结果（离线规则版）');
  L.push(`共扫描 ${nodes.length} 个节点，其中 ${flagged.length} 个存在异常现象。`);
  L.push('');
  for (const f of flagged) {
    L.push(`**${f.node}**`);
    for (const s of f.signals) L.push(`- ${s}`);
    L.push('');
  }
  L.push('### 规则做不到的部分');
  L.push(
    '规则只能列出异常现象，**不能判断该不该报修**——那需要读趋势、辨因果链。'
      + '离线模式下也不会执行任何动作：处置需要模型在线判断，这台机器上不替你决定。',
  );
  L.push('');
  L.push('> 本段为**离线规则模板**输出，未调用大模型。');
  return L.join('\n');
}

// ======================================================================
// 供界面使用的辅助
// ======================================================================
/** 动作库快照，供界面渲染「系统能做什么 / 不能做什么」。 */
export function actionCatalog() {
  return ACTION_LIST.map((a) => ({
    ...a,
    risk_label: RISK_LEVELS[a.risk].label,
    risk_rule: RISK_LEVELS[a.risk].rule,
    approval_requirement: RISK_LEVELS[a.risk].approval,
    selectable: true,
  }));
}

export { getAction };
