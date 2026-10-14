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
import { RISK_LEVELS, ACTION_LIST, getAction, selectableActions } from './actions.js';

// ======================================================================
// 工具声明（Gemini functionDeclarations 格式）
// ======================================================================
export const TOOL_SPECS = [
  {
    name: 'scan_cluster',
    description:
      '主动巡检整个集群，返回需要注意的节点清单（每个节点附带机器提取的异常现象）。' +
      '**值班模式下应该先调本工具**——不要等人贴报错，先自己看看集群里有什么不对。' +
      '返回的 signals 是现象而不是分类，同一个信号在不同节点上可能指向相反结论。',
    parameters: {
      type: 'object',
      properties: {
        include_healthy: {
          type: 'boolean',
          description: '是否连健康节点一起返回（默认 false，只返回需要关注的）。',
        },
      },
    },
  },
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
    name: 'execute_action',
    description:
      '对一个节点执行修复动作。**只有低风险动作会被真正执行**（例如禁止节点接新任务、' +
      '重启任务进程、开启显存可扩展段）。中风险与高风险动作会被本工具拒绝，' +
      '并返回「需要人工审批」——此时你必须改用 propose_fix 登记，交给审批流。' +
      '你无法通过本工具绕过审批。执行后本工具会自动回读状态确认改动生效。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点标识，如 lyg2112' },
        action_id: { type: 'string', description: '修复动作编号，必须来自系统指令里给出的动作库候选清单' },
        reason: { type: 'string', description: '为什么现在要执行它，一两句话。会记入操作日志。' },
        params: {
          type: 'object',
          description: '命令里需要替换的占位符，例如 {"NODE_NAME": "lyg2112", "GPU_INDEX": 3}。',
        },
      },
      required: ['node', 'action_id', 'reason'],
    },
  },
  {
    name: 'draft_ticket',
    description:
      '为需要人工决策的高风险动作（例如硬件报修）准备一张工单草稿：填好证据、命令与' +
      '判断依据，人只需要点确认。**本工具不会提交工单**——报修不可逆，提交必须由人来做。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点标识' },
        action_id: { type: 'string', description: '动作编号，例如 file_rma' },
        title: { type: 'string', description: '工单标题' },
        body: { type: 'string', description: '工单正文：结论、判断依据、建议动作、需要人确认的点' },
        priority: { type: 'string', description: 'normal / high / urgent' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: '支撑本工单的工具调用编号，如 ["T2","T5"]。必须是工具返回值里出现过的 ref。',
        },
      },
      required: ['node', 'action_id', 'title', 'body'],
    },
  },
  {
    name: 'notify_operator',
    description:
      '把结论与待办推给值班人。判完之后要主动告诉人「有一件事在等你」，' +
      '而不是等人自己来看页面。高风险项尤其应该调用它。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '涉及的节点' },
        title: { type: 'string', description: '一句话标题，例如「lyg2112 疑似显存劣化，需要批准报修」' },
        text: { type: 'string', description: '正文：发生了什么、已经做了什么、需要人决定什么' },
        severity: { type: 'string', description: 'info / warning / critical' },
      },
      required: ['node', 'title', 'text'],
    },
  },
  {
    name: 'propose_fix',
    description:
      '登记一条修复建议。每给出一条建议都必须调用本工具，否则不会出现在交付给运维的处置清单里。' +
      '必须给出 classification（故障归类）与 confidence（置信度）。' +
      '★ 动作必须从修复动作库里选用（传 action_id，候选清单见系统指令）。' +
      '风险等级由动作库决定，你无法声明或修改它——不要试图在文本里给动作重新定级。',
    parameters: {
      type: 'object',
      properties: {
        action_id: {
          type: 'string',
          description:
            '修复动作编号，必须来自系统指令里给出的修复动作库候选清单。' +
            '不得自造编号。若清单里没有合适的动作，就不要调用本工具，只输出结论。',
        },
        title: { type: 'string', description: '这条建议在本案里的侧重点，不超过 20 字' },
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
        effort: { type: 'string', description: '实施成本：低 / 中 / 高' },
        evidence: { type: 'string', description: '支撑该建议的具体事实，一两句话' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: '支撑该结论的工具调用编号，如 ["T1","T3"]。必须是工具返回值里出现过的 ref。',
        },
      },
      required: ['action_id', 'title', 'detail', 'classification', 'confidence'],
    },
  },
];

// ======================================================================
// 工具执行状态
// ======================================================================
/** 承载一次分诊会话的证据、引用与产出。 */
export class ToolState {
  /**
   * @param evidence 归一化后的证据包（来自案例或粘贴的日志）
   * @param pre      预分析结果
   * @param options.cluster  模拟集群客户端。**通过注入而不是 import**，
   *   是为了让本文件保持零外部依赖——自检脚本能在 Node 里直接跑它，
   *   不需要 Firestore、不需要浏览器。不注入时，集群相关工具会如实返回
   *   「当前会话没有连接集群」，而不是假装成功了。
   */
  constructor(evidence, pre, options = {}) {
    this.evidence = evidence;
    this.pre = pre;
    this.detail = pre?.detail || {};
    this.actions = [];
    this.citations = [];
    this.cluster = options.cluster || null;
    /** 本次会话在集群上**真的执行过**的动作，供界面与执行包引用。 */
    this.executions = [];
    /** 本次会话产出的工单草稿与通知。 */
    this.tickets = [];
    this.notifications = [];
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
  /**
   * 拉取节点的硬件事件与遥测。
   *
   * ★ 两个数据源，顺序不能反：
   *   1. **实时模拟集群**（Firestore）—— Agent 主动巡检看到的就是这个。
   *      执行动作后再调一次本工具，读到的就是改动后的状态，闭环才算闭上；
   *   2. 回退到证据包里的静态遥测（F8 基准与单案例演示走这条路）。
   *
   * 两个来源都必须如实标注 `provenance`：界面上要能分清「这是刚读回来的实时状态」
   * 还是「这是演示案例里的快照」。混在一起说，等于拿演示数据冒充真实状态。
   */
  async inspect_node({ node } = {}) {
    const target = String(node || '').trim();
    if (!target) return { error: 'node 必填' };

    // ---- 1) 实时模拟集群
    if (this.cluster) {
      let live = null;
      try {
        live = await this.cluster.getNode(target);
      } catch {
        live = null; // 查询失败（例如节点不存在）就走下面的案例遥测
      }
      if (live && live.__id) {
        const tel = live.telemetry || {};
        const enriched = (tel.xid_events || []).map((e) => ({
          code: e.code,
          gpu: e.gpu ?? null,
          at: e.at,
          count: e.count ?? 1,
          name: XID_TABLE[e.code]?.name || null,
          known: Boolean(XID_TABLE[e.code]),
        }));
        return {
          ref: this._cite('inspect_node', { node: target, source: 'live', events: enriched.length }),
          node: target,
          found: true,
          source: 'live',
          // 状态与调度信息 —— 「是不是已经止损过了」靠这两个字段判断
          node_status: live.status,
          cordoned: live.cordoned ?? null,
          schedulable: live.schedulable ?? null,
          draining: live.draining ?? null,
          gpu_type: live.gpu_type,
          running_jobs: (live.jobs || []).map((j) => ({
            id: j.id, user: j.user, gpus: j.gpus, state: j.state,
          })),
          // 内核与驱动侧信号
          smi_ok: tel.smi_ok ?? null,
          smi_error: tel.smi_error || null,
          lspci_gpu_count: tel.lspci_gpu_count ?? null,
          kernel_module_loaded: tel.kernel_module_loaded ?? null,
          module_for_kernel: tel.module_for_kernel ?? null,
          secure_boot: tel.secure_boot ?? null,
          hung_process: tel.hung_process || null,
          gpu_util_pct: tel.gpu_util_pct ?? null,
          progress_stalled_minutes: tel.progress_stalled_minutes ?? null,
          // 计数与历史 —— 判断「偶发还是劣化」唯一可靠的依据
          xid_events: enriched,
          ecc_uncorrectable: tel.ecc_uncorrectable ?? null,
          ecc_correctable: tel.ecc_correctable ?? null,
          row_remap_pending: tel.row_remap_pending ?? null,
          reset_count: tel.reset_count ?? null,
          history_30d: tel.history_30d || null,
          provenance:
            '实时模拟集群状态（Firestore 读回）。这是构造的演示节点，不是你的生产集群；' +
            '字段语义对齐 nvidia-smi / DCGM 的常见口径。',
        };
      }
    }

    // ---- 2) 回退：案例证据包里的静态遥测
    const current = this.evidence.job?.node || '';
    const telemetry = this.evidence.node_telemetry;

    if (!telemetry || (target && current && target !== current)) {
      return {
        ref: this._cite('inspect_node', { node: target, found: false }),
        node: target,
        found: false,
        error: `没有节点 ${target} 的遥测数据。`,
        available_nodes: current ? [current] : [],
        hint:
          '只能查询有遥测数据的节点，不得凭空推断其他节点的状态。'
          + '若需要看整个集群，先用 scan_cluster 巡检。',
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
      source: 'case',
      window: telemetry.window,
      xid_events: enriched,
      ecc_uncorrectable: telemetry.ecc_uncorrectable,
      ecc_correctable: telemetry.ecc_correctable,
      clock_throttle: telemetry.clock_throttle,
      pcie_aer: telemetry.pcie_aer || null,
      gsp_firmware: telemetry.gsp_firmware || null,
      history_30d: telemetry.history_30d || null,
      note: telemetry.note,
      provenance: '案例证据包里的快照遥测（演示数据）；字段语义对齐 nvidia-smi / DCGM 的常见口径。',
    };
  }

  // ---------------------------------------------------------------- 6
  /**
   * 主动巡检：不需要任何人贴日志，自己去看集群里有什么不对。
   *
   * ★ 这是「主动发现」的入口，也是这个应用与「贴报错 → 给解释」的分界线。
   * 它返回的 `signals` 是**机器判定的异常信号**（现象），不是故障分类（结论）——
   * 分类必须由模型基于 inspect_node 的详细遥测自己下判断。
   * 这条边界要守住：工具一旦开始给结论，模型就会照抄，整个分诊就退化成查表。
   */
  async scan_cluster({ include_healthy = false } = {}) {
    if (!this.cluster) {
      return {
        error: '当前会话没有连接集群，无法巡检。',
        hint: '案例模式下一次只看一个节点；要巡检整个集群请从「值班」入口进入。',
      };
    }

    const nodes = await this.cluster.listNodes();
    const flagged = [];
    for (const n of nodes) {
      const signals = nodeSignals(n);
      if (!signals.length && !include_healthy) continue;
      flagged.push({
        node: n.node,
        gpu_type: n.gpu_type,
        node_status: n.status,
        schedulable: n.schedulable ?? true,
        cordoned: n.cordoned ?? false,
        running_jobs: (n.jobs || []).map((j) => `${j.id}（${j.user}，${j.state}）`),
        signals,
      });
    }
    flagged.sort((a, b) => b.signals.length - a.signals.length);

    return {
      ref: this._cite('scan_cluster', { scanned: nodes.length, flagged: flagged.length }),
      scanned_nodes: nodes.length,
      needs_attention: flagged,
      note:
        'signals 是机器提取的异常现象，**不是故障分类**。同一个信号（例如 Xid 94）' +
        '在不同节点上可能指向完全相反的结论，必须逐个调用 inspect_node 取证后再判断。',
      next:
        flagged.length
          ? '对 needs_attention 里每个节点调用 inspect_node 取详细遥测，再逐一给出分类与是否报修。'
          : '本次巡检未发现需要关注的节点。',
    };
  }

  // ---------------------------------------------------------------- 7
  /**
   * 对一个节点执行修复动作。
   *
   * ★★ 审批门槛写在这里，而不是写在提示词里。
   *
   * 提示词是**可以被说服的**——模型只要"认为"某件事风险不高，就可能绕过它。
   * 所以门槛必须是代码：只有 `risk === 'low'` 的动作会被真正执行，中风险与
   * 高风险一律返回拒绝，并告诉模型改用 propose_fix 走人工审批。
   * 模型没有任何参数可以影响这个判断——它连一个能表达「这次算低风险」的字段都没有。
   *
   * 这是「风险等级不从模型来」这条纪律在执行层的落点。也是本应用敢让 Agent
   * 自己动手的前提：它能动的只有那些「最糟也就是把当前任务重启一下」的操作。
   */
  async execute_action({ node = '', action_id = '', reason = '', params = {} } = {}) {
    const act = getAction(action_id);
    if (!act) {
      return {
        error: `修复动作库里没有「${action_id || '(空)'}」这个动作，未执行任何操作。`,
        available_actions: selectableActions(),
      };
    }
    if (act.discouraged) {
      return { error: `「${act.label}」被系统标记为不建议，拒绝执行。`, instead: act.instead };
    }

    // ★★ 安全规则**优先于**可用性检查。
    //
    // 这个顺序是自检脚本逼出来的：原先「有没有连接集群」的检查排在风险检查前面，
    // 于是没连集群时模型收到的是「没有连接集群」，而不是「这个动作你没权限执行」。
    // 在真实值班场景里，模型看到前者会以为**连上再试一次就行了**——
    // 它会把审批门槛误读成环境问题。审批是规则，规则必须先说。
    if (act.risk !== 'low') {
      const lv = RISK_LEVELS[act.risk];
      return {
        refused: true,
        action_id: act.id,
        action_label: act.label,
        risk: act.risk,
        risk_label: lv.label,
        error:
          `「${act.label}」是${lv.label}动作（${lv.rule}），` +
          `需要人工审批：${lv.approval}。你无权直接执行。`,
        instead:
          '请用 propose_fix 登记这个动作（传 action_id 与证据引用），交给人工审批流；'
          + '审批通过后由系统执行。你也可以先用 draft_ticket 把工单准备好。',
        allowed_to_execute_now: lowRiskActionIds(),
      };
    }

    if (!this.cluster) {
      return {
        error: '当前会话没有连接集群，无法执行动作。',
        hint: '这条动作本身是允许自主执行的，只是当前会话没有连接模拟集群。',
      };
    }

    const out = await this.cluster.executeAction({
      node, actionId: action_id, params, actor: 'agent', reason,
    });
    if (!out.ok && out.error) {
      return {
        ref: this._cite('execute_action', { node, action_id, verified: false, error: out.error }),
        executed: false,
        error: `执行失败：${out.error}`,
      };
    }

    this.executions.push({ node, action_id, event: out.event, before: out.before, after: out.after });

    return {
      ref: this._cite('execute_action', { node, action_id, verified: out.verified }),
      executed: true,
      node,
      action_id,
      action_label: act.label,
      risk: act.risk,
      describe: out.planned.describe,
      fields_written: Object.keys(out.planned.fields),
      // ★ 回验结果必须原样返回。执行了但状态没变，就要说没变。
      verified: out.verified,
      before: { status: out.before?.status, cordoned: out.before?.cordoned, schedulable: out.before?.schedulable },
      after: { status: out.after?.status, cordoned: out.after?.cordoned, schedulable: out.after?.schedulable },
      note: out.verified
        ? '已回读服务端状态，确认改动生效。'
        : '⚠️ 执行后回读的状态与预期不符，动作可能未生效——请在结论里如实说明。',
    };
  }

  // ---------------------------------------------------------------- 8
  /**
   * 为需要人工决策的高风险动作准备工单草稿。
   *
   * ★ 它**只建草稿，不提交**。报修是不可逆的资源决策：走一次 RMA，集群就少一块卡。
   * Agent 能做的，是把工单准备到「人只需要点确认」的程度——证据、命令、序列号位置、
   * 判断依据全部填好。按下提交键这件事必须由人来做。
   */
  async draft_ticket({
    node = '', action_id = '', title = '', body = '', priority = 'normal', evidence_refs = [],
  } = {}) {
    const act = getAction(action_id);
    if (!act) {
      return { error: `修复动作库里没有「${action_id || '(空)'}」这个动作。`, available_actions: selectableActions() };
    }
    if (!this.cluster) return { error: '当前会话没有连接集群，无法创建工单。' };

    const validRefs = (Array.isArray(evidence_refs) ? evidence_refs : [])
      .filter((r) => this.citations.some((c) => c.ref === r));

    const t = await this.cluster.createTicket({
      node, actionId: action_id, title, body, evidence_refs: validRefs, priority, created_by: 'agent',
    });
    this.tickets.push(t);

    return {
      ref: this._cite('draft_ticket', { node, action_id, ticket: t.__id }),
      created: t.__id,
      status: 'draft',
      action_label: act.label,
      dropped_refs: (Array.isArray(evidence_refs) ? evidence_refs : []).filter(
        (r) => !this.citations.some((c) => c.ref === r),
      ),
      note:
        '工单已备好（草稿状态）。★ 它不会自动提交——报修不可逆，提交必须由人来做。',
      next: '用 notify_operator 把这件事推给值班人，说明「有一件事等你批准」。',
    };
  }

  // ---------------------------------------------------------------- 9
  /**
   * 把结论与待办推给值班人。
   *
   * ★ 这是「主动触达」。Agent 不等于「等人来看页面」——判完之后要主动告诉人
   * 有一件事在等他，这才叫把流程跑完。
   *
   * ⚠️ 诚实边界：本条消息落到通知队列（notifications 集合），状态保持 queued。
   * 真实部署时这里应该接你的 IM / 邮件系统。演示环境里它以「值班群消息」的形式
   * 呈现，便于现场核对内容是否准确——不假装它已经发出去了。
   */
  async notify_operator({ node = '', title = '', text = '', severity = 'warning' } = {}) {
    if (!this.cluster) return { error: '当前会话没有连接集群，无法投递通知。' };
    const n = await this.cluster.notify({ node, title, text, severity, channel: 'im' });
    this.notifications.push(n);
    return {
      ref: this._cite('notify_operator', { node, title }),
      delivered_to: '值班通知队列',
      status: 'queued',
      severity,
      title,
      note:
        '通知已入队（状态 queued）。演示环境呈现为「值班群消息」；'
        + '真实部署需接入 IM / 邮件推送渠道。',
    };
  }

  // ---------------------------------------------------------------- 10
  propose_fix({
    action_id,
    title,
    detail,
    classification = 'undetermined',
    confidence = 0.5,
    should_rma = null,
    blocks_job = null,
    effort = '中',
    evidence = '',
    evidence_refs = [],
  } = {}) {
    // ★★ 风险等级的唯一来源：动作库。
    //
    // 模型只能提供 action_id，风险等级 / 影响面 / 命令 / 回滚步骤全部从库里取。
    // 这样模型就**没有途径**把一个高风险动作（比如重装驱动、提交 RMA）
    // 降级成低风险来绕过审批——它连表达「这个动作是低风险」的字段都没有。
    //
    // 若模型编了一个不存在的 id，我们不登记这条建议，而是把可用清单回给它，
    // 让它自己纠正。硬拒比「宽容地接受一个假 id」安全得多。
    const act = getAction(action_id);
    if (!act) {
      return {
        error: `修复动作库里没有「${action_id || '(空)'}」这个动作，本次建议未登记。`,
        available_actions: selectableActions(),
        hint:
          '必须从上面的候选清单里挑一个 action_id 重新调用 propose_fix。' +
          '不得自造动作编号，也不得试图自行声明风险等级。' +
          '如果清单里确实没有合适的动作，就不要登记建议，只在最终结论里说明处置方向。',
      };
    }
    if (act.discouraged) {
      return {
        error: `「${act.label}」被系统标记为不建议：${act.reason}`,
        instead: act.instead,
        available_actions: selectableActions(),
      };
    }

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
      action_id: act.id,
      // 动作名以库为准，模型给的首字（title）作为「本例侧重」
      action_label: act.label,
      risk: act.risk,
      risk_label: RISK_LEVELS[act.risk].label,
      risk_rule: RISK_LEVELS[act.risk].rule,
      approval_requirement: RISK_LEVELS[act.risk].approval,
      affects: act.affects,
      cmds: act.cmds,
      params: act.params,
      expect: act.expect,
      rollback: act.rollback,
      note: act.note,
      source: act.source,
      title: String(title || act.label).slice(0, 60),
      detail: String(detail),
      classification: cls,
      classification_label: CLASSES[cls].label,
      should_rma: should_rma === null ? null : Boolean(should_rma),
      blocks_job: blocks_job === null ? null : Boolean(blocks_job),
      confidence: Math.round(conf * 100) / 100,
      effort: String(effort),
      evidence: String(evidence || ''),
      evidence_refs: validRefs,
    };
    this.actions.push(action);

    const out = {
      registered: action.id,
      total_fixes: this.actions.length,
      classification: cls,
      // 把风险等级回传给模型：它需要在最终叙述里引用这个等级，
      // 而不是自己编一个。等级本身仍然是库给的，不是模型给的。
      risk: act.risk,
      risk_label: RISK_LEVELS[act.risk].label,
      approval_required: RISK_LEVELS[act.risk].approval,
      command: act.cmds,
      rollback: act.rollback,
    };
    if (droppedRefs.length) {
      out.warning = `以下引用编号不存在，已丢弃：${droppedRefs.join('、')}。只能用工具返回值里出现过的 ref。`;
    }
    return out;
  }
}

// ======================================================================
// 巡检信号的提取
// ======================================================================
/**
 * 从一个节点文档里提取**异常现象**。
 *
 * ★ 只描述现象，绝不给结论。
 *
 * 这条边界必须守住：如果这里返回「这是硬件故障」，模型就会照抄，整个分诊
 * 退化成查表——而我们已经用 F8 基准证明过查表是不够的。所以这里只说
 * 「Xid 94 出现了 41 次」，不说「这表示显存劣化」。
 *
 * 恰好地，同一个现象（Xid 94 × 41）在不同节点上指向完全相反的结论，
 * 所以「给结论」这件事在这里也做不到——判别需要跨字段的因果推断。
 */
export function nodeSignals(n = {}) {
  const out = [];
  const t = n.telemetry || {};

  if (n.status && !['healthy', 'rebooting'].includes(n.status)) {
    out.push(`节点状态为 ${n.status}`);
  }
  if (t.smi_ok === false) {
    out.push(`nvidia-smi 读不到设备${t.smi_error ? `：${t.smi_error}` : ''}`);
  }
  if (
    typeof t.lspci_gpu_count === 'number' &&
    typeof n.gpu_count === 'number' &&
    t.lspci_gpu_count < n.gpu_count
  ) {
    out.push(`lspci 只看到 ${t.lspci_gpu_count} 张卡（应有 ${n.gpu_count} 张）`);
  }
  for (const e of t.xid_events || []) {
    const known = XID_TABLE[e.code];
    out.push(
      `Xid ${e.code}${known ? `（${known.name}）` : '（知识库无记录）'}` +
        ` ×${e.count ?? 1}` +
        (e.gpu !== undefined && e.gpu !== null ? `，GPU ${e.gpu}` : '') +
        (e.at ? `，最近 ${e.at}` : ''),
    );
  }
  if (t.ecc_uncorrectable > 0) out.push(`不可纠正 ECC 计数 ${t.ecc_uncorrectable}`);
  if (t.row_remap_pending > 0) out.push(`待重映射的坏行 ${t.row_remap_pending}`);

  const h = t.history_30d;
  if (h) {
    if (h.xid94_count > 0) out.push(`近 30 天 Xid 94 累计 ${h.xid94_count} 次`);
    if (h.ecc_correctable_trend && h.ecc_correctable_trend !== 'flat') {
      out.push(`可纠正 ECC 呈 ${h.ecc_correctable_trend} 趋势`);
    }
  }
  if (typeof t.ecc_correctable === 'number' && t.ecc_correctable > 0) {
    out.push(`可纠正 ECC 当前计数 ${t.ecc_correctable}`);
  }
  if (t.hung_process) {
    const p = t.hung_process;
    out.push(`进程 ${p.pid} 处于 ${p.state} 状态，阻塞在 ${p.wchan}，已持续 ${p.etime}`);
  }
  if (t.progress_stalled_minutes) {
    out.push(
      `训练已停摆 ${t.progress_stalled_minutes} 分钟，而 GPU 利用率仍是 ${t.gpu_util_pct ?? '?'}%`,
    );
  }
  if (t.module_for_kernel === false) out.push('nvidia 内核模块并非针对当前内核编译');
  if (t.secure_boot === true) out.push('Secure Boot 处于开启状态');

  return out;
}

/** 允许 Agent 自主执行的动作（低风险）—— 用于在拒绝时告诉模型「你能做什么」。 */
const lowRiskActionIds = () => ACTION_LIST.filter((a) => a.risk === 'low').map((a) => a.id);

// ======================================================================
// 参数白名单分发
// ======================================================================
/**
 * 工具名 → 允许的参数白名单。
 *
 * ★ 这里刻意**不写方法名**：ToolState 上的方法名与工具名保持完全一致，
 * 分发时直接用工具名作为方法名去调。
 *
 * 原因是踩过一次坑：原来这张表写成 `{ 工具名: [方法名, 白名单] }`，
 * 于是同一个名字要维护两份（`lookup_xid` 与 `lookupXid`）。一旦哪天改了一处
 * 忘了另一处，dispatchTool 的 try/catch 会把它吞成一句「工具报错了」——
 * 模型只会看到「这个工具坏了」，真因藏在分发表里，靠读代码几乎发现不了。
 * 六个工具里有五个当时就是坏的，直到自检脚本（scripts/verify_triage.mjs）
 * 逐个去比才暴露出来。
 *
 * 现在「工具名 == 方法名」，这种错位在结构上就不可能出现。
 */
export const TOOL_PARAMS = {
  scan_cluster: ['include_healthy'],
  search_failure_signature: ['query'],
  lookup_xid: ['code'],
  check_compat: ['driver', 'cuda_runtime', 'torch', 'nccl'],
  estimate_memory: [
    'model_params_b', 'precision', 'batch_size', 'seq_len', 'hidden_size',
    'num_layers', 'tp', 'dp', 'zero_stage', 'recompute', 'flash_attn', 'gpu_type',
  ],
  inspect_node: ['node'],
  execute_action: ['node', 'action_id', 'reason', 'params'],
  draft_ticket: ['node', 'action_id', 'title', 'body', 'priority', 'evidence_refs'],
  notify_operator: ['node', 'title', 'text', 'severity'],
  propose_fix: [
    'action_id', 'title', 'detail', 'classification', 'confidence', 'should_rma',
    'blocks_job', 'effort', 'evidence', 'evidence_refs',
  ],
};

/**
 * ★ 工具清单要按**模式**裁剪，不能两个模式都给全套。
 *
 * 单次分诊拿到的是一段已经在手上的报错，它要产出的是「判断 + 方案 + 执行包」，
 * 而且它**根本没有连集群**。所以 scan_cluster / execute_action / draft_ticket /
 * notify_operator 这四个在这个模式下不但没用，还会让模型白调一次、收到一句
 * 「当前会话没有连接集群」，在界面的调用轨迹上留下一行看着像故障的记录。
 *
 * 第一次跑浏览器验收时就真出过这个：单次分诊里模型调了 notify_operator，
 * 结果拿回「当前会话没有连接集群，无法投递通知」。
 * **给模型一把开不了门的钥匙，责任在设计，不在模型。**
 *
 * 反过来，值班巡检需要全套，而且顺序是有讲究的：
 *   先发现（scan_cluster）→ 再取证（inspect_node）→ 再处置（execute_action）
 *   → 再触达（draft_ticket / notify_operator）。
 */
export const CASE_MODE_TOOLS = [
  'search_failure_signature',
  'lookup_xid',
  'check_compat',
  'estimate_memory',
  'inspect_node',
  'propose_fix',
];

/** 按模式取工具声明。mode='case' 只给分诊类工具；mode='patrol' 给全套。 */
export function toolSpecsFor(mode = 'case') {
  if (mode === 'patrol') return TOOL_SPECS;
  const allow = new Set(CASE_MODE_TOOLS);
  return TOOL_SPECS.filter((s) => allow.has(s.name));
}

/**
 * 执行一次工具调用。
 *
 * 模型偶尔会把多余参数传进来（甚至试图传一个 risk 来给动作重新定级），
 * 所以这里只取白名单里的字段。**白名单同时是安全边界**：不在表里的参数
 * 连进都进不来，模型无法通过新增字段影响风险判定。
 *
 * ★ 必须 await：巡检、执行、工单、通知这几个工具要访问集群，是异步的。
 */
export async function dispatchTool(name, args, state) {
  const key = String(name || '').trim();
  const allowed = TOOL_PARAMS[key];
  if (!allowed) {
    return {
      error: `未知工具 ${key}`,
      available_tools: Object.keys(TOOL_PARAMS).sort(),
    };
  }
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (allowed.includes(k)) clean[k] = v;
  }
  try {
    return await state[key](clean);
  } catch (exc) {
    // 工具异常不中断会话，把它当成一次有信息的失败返回给模型。
    // ⚠️ 正因为它会吞异常，工具名与方法名必须由结构保证一致（见 TOOL_PARAMS 注释）。
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
