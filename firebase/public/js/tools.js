/**
 * AI 可分诊工具集。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 这一层的设计意图
 * ────────────────────────────────────────────────────────────────────────
 * 分诊最怕的不是模型不够聪明，而是**模型太聪明地编造**。
 * 所以六个工具全部只做一件事：**返回证据**。它们从不返回结论，
 * 也从不返回「建议分类」——分类必须由模型自己基于多条证据下判断。
 *
 * 每个工具返回值都带一个 `ref`（如 T3）。模型在 `propose_fix` 里引用它，
 * 前端就能把每条修复建议连回产生它的那次工具调用。这是「可溯源」从口号
 * 变成界面上看得见的东西的地方。
 *
 * 六个工具：
 *     search_failure_signature  在故障特征库里检索已知模式
 *     lookup_xid                查 NVIDIA Xid 错误码的权威含义与处置
 *     check_compat              校验 driver / CUDA / torch 版本栈是否自洽
 *     estimate_memory           核算训练显存需求，判断能否装得下
 *     inspect_node              拉取该节点的硬件事件与遥测
 *     propose_fix               登记一条修复建议（前端据此渲染接受/拒绝）
 */

import { XID_TABLE, FAILURE_SIGNATURES, CLASSES } from './kb.js';
import {
  checkCompatibility,
  estimateTrainingMemory,
  extractXids,
  matchSignatures,
} from './triage.js';

// ======================================================================
// 工具声明（Gemini functionDeclarations 格式）
// ======================================================================
export const TOOL_SPECS = [
  {
    name: 'search_failure_signature',
    description:
      '在故障特征库里检索与一段现象描述相符的已知模式。' +
      '可以传原始报错文本，也可以传一句话现象描述（如「集合通信超时」）。' +
      '返回的是候选模式的典型根因与应核实项，**不是最终结论**。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要检索的报错文本或现象描述。留空则列出全部可用模式。',
        },
      },
    },
  },
  {
    name: 'lookup_xid',
    description:
      '查询 NVIDIA Xid 错误码的权威含义、故障归类与推荐处置。' +
      '凡日志或节点遥测里出现 Xid，都必须先查本工具再下结论。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'integer', description: 'Xid 码，如 48、79、94' },
      },
      required: ['code'],
    },
  },
  {
    name: 'check_compat',
    description:
      '校验驱动 / CUDA 运行时 / PyTorch 的版本组合是否自洽，返回逐条核验结果。' +
      '不传参数则使用证据包里已有的环境信息。',
    parameters: {
      type: 'object',
      properties: {
        driver: { type: 'string', description: 'NVIDIA 驱动版本，如 535.104.12' },
        cuda_runtime: { type: 'string', description: 'CUDA 运行时版本，如 12.6' },
        torch: { type: 'string', description: 'PyTorch 版本，如 2.6.0+cu126' },
        nccl: { type: 'string', description: 'NCCL 版本，如 2.22.3' },
      },
    },
  },
  {
    name: 'estimate_memory',
    description:
      '核算训练显存需求：模型状态（精确）+ 激活值（区间），并与目标卡型容量比对，' +
      '给出 comfortable / tight / will_oom 判定。不传参数则使用证据包里的训练配置。',
    parameters: {
      type: 'object',
      properties: {
        model_params_b: { type: 'number', description: '模型参数量，单位十亿（B）' },
        precision: { type: 'string', description: 'bf16 / fp16 / fp32' },
        batch_size: { type: 'integer', description: '单卡 microbatch' },
        seq_len: { type: 'integer', description: '序列长度' },
        hidden_size: { type: 'integer', description: 'hidden size' },
        num_layers: { type: 'integer', description: '层数' },
        tp: { type: 'integer', description: '张量并行度' },
        dp: { type: 'integer', description: '数据并行度' },
        zero_stage: { type: 'integer', description: 'ZeRO 阶段 0-3' },
        recompute: { type: 'boolean', description: '是否开启梯度重计算' },
        flash_attn: { type: 'boolean', description: '是否使用 FlashAttention' },
        gpu_type: { type: 'string', description: '卡型，如 H800 / A100_80 / H20' },
      },
    },
  },
  {
    name: 'inspect_node',
    description:
      '拉取指定节点的硬件事件与遥测：Xid 事件序列、ECC 计数、降频、PCIe 错误、' +
      '以及该卡近 30 天的历史。**这是判断「偶发还是劣化」的唯一依据。**',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点标识，如 lyg2103' },
      },
      required: ['node'],
    },
  },
  {
    name: 'propose_fix',
    description:
      '登记一条修复建议。每给出一条建议都必须调用本工具，否则不会出现在交付给' +
      '运维的处置清单里。必须给出 classification（故障归类）与 confidence（置信度）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '动作名称，不超过 20 字' },
        detail: { type: 'string', description: '具体怎么做，一到两句话' },
        classification: {
          type: 'string',
          description:
            '故障归类，必须取以下之一：application（应用/代码缺陷）、' +
            'hardware（硬件故障，需隔离报修）、hardware_watch（硬件观察项，暂不报修）、' +
            'environment（环境/版本不兼容）、config（配置/资源参数错误）、' +
            'network（网络/通信）、undetermined（证据不足）',
        },
        confidence: {
          type: 'number',
          description: '置信度 0-1。证据不足时必须如实给低值，不要凑高。',
        },
        should_rma: {
          type: 'boolean',
          description: '是否应进入硬件报修/RMA 流程。这是给运维最直接的一个判断。',
        },
        blocks_job: {
          type: 'boolean',
          description: '该项不处理是否会导致任务继续失败。',
        },
        risk: {
          type: 'string',
          description: '执行该项的风险或副作用，如「会降速」「需要重启节点」。',
        },
        effort: { type: 'string', description: '实施成本：低 / 中 / 高' },
        evidence: { type: 'string', description: '支撑该建议的具体事实，一两句话' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: '支撑该结论的工具调用编号，如 ["T1","T3"]。必须是工具返回值里出现过的 ref。',
        },
      },
      required: ['title', 'detail', 'classification', 'confidence'],
    },
  },
];

// ======================================================================
// 工具执行状态
// ======================================================================
/** 承载一次分诊会话的证据、引用与产出。 */
export class ToolState {
  constructor(evidence, pre) {
    this.evidence = evidence;
    this.pre = pre;
    this.detail = pre?.detail || {};
    this.actions = [];
    this.citations = [];
  }

  /** 记一条引用，返回它的编号（T1、T2…）。让结论可以指回证据。 */
  _cite(source, payload) {
    const ref = `T${this.citations.length + 1}`;
    this.citations.push({ ref, source, payload });
    return ref;
  }

  // ---------------------------------------------------------------- 1
  search_failure_signature({ query = '' } = {}) {
    const q = String(query || '').trim();

    if (!q) {
      return {
        ref: this._cite('search_failure_signature', { query: '' }),
        available: FAILURE_SIGNATURES.map((s) => ({ id: s.id, label: s.label, class_hint: s.class_hint })),
        note: '未提供 query，返回全部可用模式清单。',
      };
    }

    // 先按正则命中，再按关键词命中，两路合并去重
    const byPattern = new Set(matchSignatures(q).map((h) => h.id));
    const lower = q.toLowerCase();
    const byKeyword = new Set();
    for (const sig of FAILURE_SIGNATURES) {
      const hay = [sig.label, sig.root_cause, ...sig.typical_fix, ...sig.check].join(' ').toLowerCase();
      // 中文与英文关键词都用「2 字以上的词块是否出现」来近似
      const tokens = lower.match(/[a-z_]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
      if (tokens.some((t) => hay.includes(t))) byKeyword.add(sig.id);
    }

    const ids = [...new Set([...byPattern, ...byKeyword])];
    const matches = ids
      .map((id) => FAILURE_SIGNATURES.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        label: s.label,
        class_hint: s.class_hint,
        class_hint_note: '这是默认倾向，不是结论；必须结合 Xid、遥测与版本栈再判断。',
        root_cause: s.root_cause,
        check: s.check,
        typical_fix: s.typical_fix,
        source: s.source,
        matched_by: byPattern.has(s.id) ? 'pattern' : 'keyword',
      }));

    return {
      ref: this._cite('search_failure_signature', { query: q, matched: matches.length }),
      query: q,
      matched: matches.length,
      signatures: matches,
      note: matches.length
        ? '以上为候选模式，请结合 lookup_xid / inspect_node / check_compat 的结果再定性。'
        : '特征库里没有匹配项。请改用其他关键词，或直接核对 Xid 与节点遥测。',
    };
  }

  // ---------------------------------------------------------------- 2
  lookup_xid({ code } = {}) {
    const n = Number(code);
    if (!Number.isInteger(n)) return { error: 'code 必须是整数' };

    const entry = XID_TABLE[n];
    if (!entry) {
      return {
        ref: this._cite('lookup_xid', { code: n, found: false }),
        code: n,
        found: false,
        error: `知识库里没有 Xid ${n} 的记录，不得对其含义进行推测。`,
        known_codes: Object.keys(XID_TABLE).map(Number).sort((a, b) => a - b),
      };
    }

    return {
      ref: this._cite('lookup_xid', { code: n }),
      code: n,
      found: true,
      name: entry.name,
      name_en: entry.name_en,
      class: entry.class,
      class_label: CLASSES[entry.class]?.label || entry.class,
      severity: entry.severity,
      meaning: entry.meaning,
      recommended_action: entry.action,
      should_rma: entry.rma,
      source: entry.source,
      warning:
        n === 45 || n === 154
          ? '★ 这条 Xid 是「前序错误的后果」而非根因，必须回查触发它的更早事件。'
          : null,
    };
  }

  // ---------------------------------------------------------------- 3
  check_compat(args = {}) {
    const env = { ...(this.evidence.environment || {}) };
    for (const k of ['driver', 'cuda_runtime', 'torch', 'nccl']) {
      if (args[k]) env[k] = args[k];
    }
    const result = checkCompatibility(env);
    return {
      ref: this._cite('check_compat', { env, ok: result.ok }),
      checked: result.info,
      ok: result.ok,
      issues: result.issues,
      note: result.ok
        ? '版本组合自洽，未发现不兼容项。'
        : '发现阻断性不兼容项，应优先于硬件方向排查。',
    };
  }

  // ---------------------------------------------------------------- 4
  estimate_memory(args = {}) {
    const cfg = { ...(this.evidence.training_config || {}) };
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null && v !== '') cfg[k] = v;
    }
    if (!cfg.gpu_type && this.evidence.job?.gpu_type) cfg.gpu_type = this.evidence.job.gpu_type;

    const result = estimateTrainingMemory(cfg);
    if (result.error) {
      return {
        ref: this._cite('estimate_memory', { error: result.error }),
        error: result.error,
        hint: '模型参数量（model_params_b，单位十亿）是必填项。',
      };
    }
    return {
      ref: this._cite('estimate_memory', { inputs: result.inputs, total: result.total_range_gb }),
      ...result,
      note:
        `状态部分（${result.states_gb} GB）为精确值；激活值为估算区间，` +
        '因此总量以区间形式给出。fit 判定已按单卡容量的 90% 预留碎片空间。',
    };
  }

  // ---------------------------------------------------------------- 5
  inspect_node({ node } = {}) {
    const target = String(node || '').trim();
    const current = this.evidence.job?.node || '';
    const telemetry = this.evidence.node_telemetry;

    if (!target) return { error: 'node 必填' };

    if (!telemetry || (target && current && target !== current)) {
      return {
        ref: this._cite('inspect_node', { node: target, found: false }),
        node: target,
        found: false,
        error: `证据包里没有节点 ${target} 的遥测数据。`,
        available_nodes: current ? [current] : [],
        hint: '只能查询证据包中已有遥测的节点，不得凭空推断其他节点的状态。',
      };
    }

    const enriched = (telemetry.xid_events || []).map((e) => ({
      ...e,
      name: XID_TABLE[e.code]?.name || null,
      class: XID_TABLE[e.code]?.class || null,
    }));

    return {
      ref: this._cite('inspect_node', { node: target, events: enriched.length }),
      node: target,
      found: true,
      window: telemetry.window,
      xid_events: enriched,
      ecc_uncorrectable: telemetry.ecc_uncorrectable,
      ecc_correctable: telemetry.ecc_correctable,
      clock_throttle: telemetry.clock_throttle,
      pcie_aer: telemetry.pcie_aer || null,
      gsp_firmware: telemetry.gsp_firmware || null,
      history_30d: telemetry.history_30d || null,
      note: telemetry.note,
      provenance: '节点遥测为演示数据；字段语义对齐 nvidia-smi / DCGM 的常见口径。',
    };
  }

  // ---------------------------------------------------------------- 6
  propose_fix({
    title,
    detail,
    classification = 'undetermined',
    confidence = 0.5,
    should_rma = null,
    blocks_job = null,
    risk = '',
    effort = '中',
    evidence = '',
    evidence_refs = [],
  } = {}) {
    const cls = CLASSES[classification] ? classification : 'undetermined';
    const conf = Math.max(0, Math.min(1, Number(confidence) || 0));

    // 只保留真实存在过的引用编号，避免模型编造出处
    const validRefs = Array.isArray(evidence_refs)
      ? evidence_refs.filter((r) => this.citations.some((c) => c.ref === r))
      : [];
    const droppedRefs = Array.isArray(evidence_refs)
      ? evidence_refs.filter((r) => !this.citations.some((c) => c.ref === r))
      : [];

    const action = {
      id: `F${this.actions.length + 1}`,
      title: String(title).slice(0, 60),
      detail: String(detail),
      classification: cls,
      classification_label: CLASSES[cls].label,
      should_rma: should_rma === null ? null : Boolean(should_rma),
      blocks_job: blocks_job === null ? null : Boolean(blocks_job),
      confidence: Math.round(conf * 100) / 100,
      risk: String(risk || ''),
      effort: String(effort),
      evidence: String(evidence || ''),
      evidence_refs: validRefs,
    };
    this.actions.push(action);

    const out = { registered: action.id, total_fixes: this.actions.length, classification: cls };
    if (droppedRefs.length) {
      out.warning = `以下引用编号不存在，已丢弃：${droppedRefs.join('、')}。只能用工具返回值里出现过的 ref。`;
    }
    return out;
  }
}

// ======================================================================
// 参数白名单分发
// ======================================================================
const HANDLERS = {
  search_failure_signature: ['searchFailureSignature', ['query']],
  lookup_xid: ['lookupXid', ['code']],
  check_compat: ['checkCompat', ['driver', 'cuda_runtime', 'torch', 'nccl']],
  estimate_memory: [
    'estimateMemory',
    [
      'model_params_b', 'precision', 'batch_size', 'seq_len', 'hidden_size',
      'num_layers', 'tp', 'dp', 'zero_stage', 'recompute', 'flash_attn', 'gpu_type',
    ],
  ],
  inspect_node: ['inspectNode', ['node']],
  propose_fix: [
    'proposeFix',
    [
      'title', 'detail', 'classification', 'confidence', 'should_rma',
      'blocks_job', 'risk', 'effort', 'evidence', 'evidence_refs',
    ],
  ],
};

/**
 * 执行一次工具调用。
 *
 * 模型偶尔会把驼峰名（lookupXid）或多余参数传进来，所以这里做两件事：
 *   1. 只取白名单里的字段，避免脏参数导致崩溃；
 *   2. 名称大小写/下划线不匹配时给出可用工具清单，让模型自我纠正。
 */
export function dispatchTool(name, args, state) {
  const key = String(name || '').trim();
  const entry = HANDLERS[key];
  if (!entry) {
    return {
      error: `未知工具 ${key}`,
      available_tools: Object.keys(HANDLERS).sort(),
    };
  }
  const [methodName, allowed] = entry;
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (allowed.includes(k)) clean[k] = v;
  }
  try {
    return state[methodName](clean);
  } catch (exc) {
    // 工具异常不中断会话，把它当成一次有信息的失败返回给模型
    return { error: `${(exc && exc.name) || 'Error'}: ${(exc && exc.message) || exc}` };
  }
}

/** 供界面显示：本会话产出的全部引用。 */
export function citationIndex(state) {
  return (state?.citations || []).map((c) => ({ ref: c.ref, source: c.source }));
}

/** 供单测使用：把一段报错文本走一遍纯规则路径（不涉及模型）。 */
export function ruleOnlyScan(text) {
  return { xids: extractXids(text), signatures: matchSignatures(text) };
}
