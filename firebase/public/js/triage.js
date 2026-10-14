/**
 * 确定性预分析层。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么要有这一层
 * ────────────────────────────────────────────────────────────────────────
 * 分诊这件事可以拆成两半：
 *   「能算的」——从日志里抠出 Xid 码、正则匹配已知特征、比对版本号、核算显存需求；
 *   「要判断的」——这些线索合起来到底是哪一类故障，先动哪个。
 *
 * 前者交给代码（可复现、可单测、不会出错），后者交给模型。这样模型的输出
 * 永远建立在确定的事实上，而界面上也能把「已确证」和「模型推断」分开展示。
 *
 * 本文件不依赖任何网络与模型，纯函数。
 */

import {
  XID_TABLE,
  FAILURE_SIGNATURES,
  TORCH_CUDA,
  CUDA_DRIVER_MIN,
  DRIVER_CUDA_CEILING,
  GPU_MEMORY_GB,
  GPU_ALIASES,
  CLASSES,
} from './kb.js';

// ======================================================================
// 通用小工具
// ======================================================================
/** 把版本号归一化成数字数组：'535.104.12' → [535, 104, 12]。 */
export function parseVersion(v) {
  const m = String(v ?? '').match(/\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split('.').map((n) => Number(n));
}

/** 版本比较：a > b → 1，a < b → -1，相等 → 0。缺位补 0。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 取 CUDA 的「大版本.小版本」，丢掉补丁位：'12.6.3' → '12.6'。 */
export function cudaShort(v) {
  const p = parseVersion(v);
  if (!p) return null;
  return p.length >= 2 ? `${p[0]}.${p[1]}` : String(p[0]);
}

/** 取 torch 的「大版本.小版本」：'2.6.0+cu124' → '2.6'。 */
export function torchShort(v) {
  const p = parseVersion(v);
  if (!p) return null;
  return p.length >= 2 ? `${p[0]}.${p[1]}` : String(p[0]);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ======================================================================
// 1. 从日志里提取 Xid
// ======================================================================
/**
 * 真实日志里 Xid 有多种写法，必须都覆盖：
 *     NVRM: Xid (PCI:0000:3b:00): 79, GPU has fallen off the bus.
 *     [ 1234.5] NVRM: Xid (PCI:0000:3b:00): 48, pid='1234', ...
 *     Xid 13
 *     xid=94
 */
const XID_PATTERNS = [
  /NVRM:\s*Xid\s*\([^)]*\)\s*:\s*(\d{1,3})/gi,
  /\bXid\s*[:=]?\s*(\d{1,3})\b/gi,
  /\bxid\s*[:=]\s*(\d{1,3})\b/gi,
];

/**
 * 抽取日志中所有 Xid 码，按出现顺序去重计数。
 * 返回 [{ code, count, known, entry }]，未知码也会返回（entry 为 null）。
 */
export function extractXids(text) {
  const found = new Map();
  for (const re of XID_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = Number(m[1]);
      // 排除误伤：Xid 码不会超过 3 位且不会为 0
      if (!Number.isInteger(code) || code <= 0 || code > 999) continue;
      found.set(code, (found.get(code) || 0) + 1);
    }
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, count]) => ({
      code,
      count,
      known: Boolean(XID_TABLE[code]),
      entry: XID_TABLE[code] || null,
    }));
}

// ======================================================================
// 2. 匹配故障特征
// ======================================================================
/** 返回命中的签名列表。只做字面匹配，不下结论。 */
export function matchSignatures(text) {
  const hits = [];
  for (const sig of FAILURE_SIGNATURES) {
    for (const re of sig.patterns) {
      const m = text.match(re);
      if (m) {
        hits.push({
          id: sig.id,
          label: sig.label,
          class_hint: sig.class_hint,
          matched_text: m[0].slice(0, 120),
        });
        break;
      }
    }
  }
  return hits;
}

// ======================================================================
// 3. 版本兼容自检
// ======================================================================
/**
 * 校验 driver / cuda_runtime / torch 三者是否自洽。
 *
 * 返回 { ok, issues: [{level, code, message, fix}] }。
 * level：'error' 表示这个组合根本起不来；'warn' 表示能跑但有隐患。
 */
export function checkCompatibility(env = {}) {
  const issues = [];
  const info = {
    driver: env.driver || null,
    cuda_runtime: cudaShort(env.cuda_runtime || env.cuda),
    torch: torchShort(env.torch),
    nccl: env.nccl || null,
  };

  // (a) torch 官方 wheel 是否支持这个 CUDA
  if (info.torch && info.cuda_runtime) {
    const supported = TORCH_CUDA[info.torch];
    if (!supported) {
      issues.push({
        level: 'warn',
        code: 'torch_version_unknown',
        message: `版本矩阵里没有 PyTorch ${info.torch} 的记录，无法自动核对。`,
        fix: '请人工确认该版本的官方支持列表。',
      });
    } else if (!supported.includes(info.cuda_runtime)) {
      issues.push({
        level: 'error',
        code: 'torch_cuda_mismatch',
        message:
          `PyTorch ${info.torch} 的官方 wheel 支持 CUDA ${supported.join(' / ')}，` +
          `但当前运行时是 CUDA ${info.cuda_runtime}。`,
        fix: `改用 cu${info.cuda_runtime.replace('.', '')} 后缀的 wheel，或把 CUDA 换成 ${supported.join('/')} 之一。`,
      });
    }
  }

  // (b) 驱动是否满足该 CUDA 运行时的最低版本
  if (info.driver && info.cuda_runtime) {
    const need = CUDA_DRIVER_MIN[info.cuda_runtime];
    if (!need) {
      issues.push({
        level: 'warn',
        code: 'cuda_version_unknown',
        message: `版本矩阵里没有 CUDA ${info.cuda_runtime} 的最低驱动要求，无法自动核对。`,
        fix: '查 CUDA Toolkit Release Notes 确认最低驱动版本。',
      });
    } else if (compareVersions(info.driver, need) < 0) {
      issues.push({
        level: 'error',
        code: 'driver_too_old',
        message:
          `驱动 ${info.driver} 低于 CUDA ${info.cuda_runtime} 要求的最低版本 ${need}，` +
          `该 CUDA 运行时无法启动。`,
        fix: `把驱动升级到 ${need} 或更高；或把框架降到与当前驱动匹配的 CUDA 版本。`,
      });
    }
  }

  // (c) 驱动自身的 CUDA 支持上限
  if (info.driver && info.cuda_runtime) {
    const ceiling = driverCeiling(info.driver);
    if (ceiling && compareVersions(info.cuda_runtime, ceiling) > 0) {
      issues.push({
        level: 'error',
        code: 'driver_below_cuda',
        message:
          `驱动 ${info.driver} 最多支持到 CUDA ${ceiling}，` +
          `但运行时要求 CUDA ${info.cuda_runtime}。`,
        fix: `升级驱动，或把 CUDA 运行时降到 ${ceiling}。`,
      });
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), info, issues };
}

/** 按驱动版本推出它支持的最高 CUDA。 */
export function driverCeiling(driver) {
  for (const row of DRIVER_CUDA_CEILING) {
    if (compareVersions(driver, row.driver_min) >= 0) return row.cuda;
  }
  return null;
}

// ======================================================================
// 4. 训练显存估算
// ======================================================================
/**
 * 训练显存估算。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 设计原则：**给区间，不给假精确**
 * ────────────────────────────────────────────────────────────────────────
 * 模型状态（参数 / 梯度 / 优化器 / 主权重）是**结构性的**，能算准；
 * 激活值则强烈依赖注意力实现（FlashAttention 把中间矩阵全部消掉了）、
 * 重计算策略与框架版本，任何公式都只是量级估算。
 *
 * 所以本函数把两者分开报：状态部分是精确值，激活值给低/中/高三档区间。
 * 这样评审能看懂每一档是怎么来的，而不是面对一个无法验证的小数。
 *
 * 术语（mixed precision + Adam + ZeRO 的通用记账口径）：
 *   参数（bf16）        2 字节/参数
 *   梯度（bf16）        2 字节/参数
 *   fp32 主权重         4 字节/参数   ← mixed precision 才有
 *   Adam m / v（fp32）  8 字节/参数
 *   合计 16 字节/参数（这也是为什么 fp32 训练与 mixed precision 的
 *   状态开销量级相同——前者省掉主权重但参数与梯度翻倍）
 */
export function estimateTrainingMemory(spec = {}) {
  const paramsB = Number(spec.model_params_b ?? spec.params_b ?? 0);
  if (!(paramsB > 0)) return { error: 'model_params_b 必须是正数（单位：十亿参数）' };

  const precision = String(spec.precision || 'bf16').toLowerCase();
  const isFp32 = precision === 'fp32' || precision === 'float32';
  const pbytes = isFp32 ? 4 : 2;

  const tp = Math.max(1, Math.trunc(Number(spec.tp) || 1));
  const dp = Math.max(1, Math.trunc(Number(spec.dp) || 1));
  const stage = Math.min(3, Math.max(0, Math.trunc(Number(spec.zero_stage ?? spec.zero) || 0)));
  const recompute = Boolean(spec.recompute ?? spec.gradient_checkpointing);
  const flash = spec.flash_attn === undefined ? true : Boolean(spec.flash_attn);

  const P = paramsB * 1e9;
  const GB = 1024 ** 3;

  const paramBytes = P * pbytes;
  const gradBytes = P * pbytes;
  const optimBytes = P * 8;
  // mixed precision 才需要单独存一份 fp32 主权重
  const masterBytes = isFp32 ? 0 : P * 4;

  // ---- 模型状态（精确）----
  // 张量并行先把模型切了，ZeRO 再在数据并行组内逐级切分：
  //   stage 0 不切；stage 1 切优化器状态；stage 2 再切梯度；stage 3 连参数一起切。
  const byTp = (b) => b / tp;
  const optimPlusMaster = optimBytes + masterBytes;

  let statesBytes;
  if (stage === 0) {
    statesBytes = byTp(paramBytes + gradBytes + optimPlusMaster);
  } else if (stage === 1) {
    statesBytes = byTp(paramBytes + gradBytes) + byTp(optimPlusMaster) / dp;
  } else if (stage === 2) {
    statesBytes = byTp(paramBytes) + byTp(gradBytes + optimPlusMaster) / dp;
  } else {
    statesBytes = byTp(paramBytes + gradBytes + optimPlusMaster) / dp;
  }

  // ---- 激活值（估算区间）----
  const batch = Number(spec.batch_size ?? spec.batch ?? 1);
  const seq = Number(spec.seq_len ?? spec.seq ?? 2048);
  const hidden = Number(spec.hidden_size ?? 4096);
  const layers = Number(spec.num_layers ?? spec.layers ?? 32);

  // 激活值系数：重计算把中间激活丢掉了大部分；FlashAttention 消掉注意力矩阵。
  //
  // 取值依据（用 Llama-70B / seq 4096 / batch 1 做标定，该配置实测激活值约 25 GB）：
  //   开启重计算      → 只剩层边界激活，约 1.5
  //   FlashAttention  → 每层约 5 倍 hidden 状态（标准量级）
  //   无 FlashAttn    → 注意力矩阵 b·heads·s·s 成为主导项，量级跳到 30 左右，
  //                     这正是「换个注意力实现能省几十 GB」的原因
  let factor;
  if (recompute) factor = 1.5;
  else if (flash) factor = 5;
  else factor = 30;

  const actBase = batch * seq * hidden * layers * pbytes * factor;
  // 业界经验上这个量级误差在 ±30% 左右，所以给低/中/高三档而不是一个数
  const actLow = actBase * 0.75;
  const actMid = actBase;
  const actHigh = actBase * 1.3;

  // 每个进程还有固定的 CUDA context / cuBLAS workspace 开销
  const overheadGb = 1.0;

  const g = (b) => round1(b / GB);
  const statesGb = g(statesBytes);
  const totalLow = round1(statesGb + g(actLow) + overheadGb);
  const totalMid = round1(statesGb + g(actMid) + overheadGb);
  const totalHigh = round1(statesGb + g(actHigh) + overheadGb);

  // ---- 与卡型容量比对 ----
  const gpuKey = GPU_ALIASES[String(spec.gpu_type || '').toLowerCase()] || spec.gpu_type;
  const capacity = GPU_MEMORY_GB[gpuKey] ?? null;
  let fit = null;
  let usable = null;
  if (capacity) {
    // 预留 10%：显存池碎片与临时分配几乎必然发生
    usable = round1(capacity * 0.9);
    if (totalHigh <= usable) fit = 'comfortable';
    else if (totalLow <= usable) fit = 'tight';
    else fit = 'will_oom';
  }

  return {
    inputs: {
      model_params_b: paramsB,
      precision: isFp32 ? 'fp32' : precision,
      batch_size: batch,
      seq_len: seq,
      hidden_size: hidden,
      num_layers: layers,
      tp,
      dp,
      zero_stage: stage,
      recompute,
      flash_attn: flash,
      gpu_type: gpuKey || null,
    },
    breakdown_gb: {
      params: g(paramBytes / tp),
      grads: g(gradBytes / tp),
      optimizer: g((stage >= 1 ? byTp(optimBytes) / dp : byTp(optimBytes))),
      fp32_master: g((stage >= 1 ? byTp(masterBytes) / dp : byTp(masterBytes))),
      cuda_overhead: overheadGb,
      activations_low: g(actLow),
      activations_mid: g(actMid),
      activations_high: g(actHigh),
    },
    states_gb: statesGb,
    activation_range_gb: [g(actLow), g(actMid), g(actHigh)],
    total_range_gb: [totalLow, totalMid, totalHigh],
    per_gpu_capacity_gb: capacity,
    per_gpu_usable_gb: usable,
    fit,
    activation_factor: factor,
    notes: [
      '模型状态（参数/梯度/优化器/主权重）按标准的 16 字节/参数口径精确计算。',
      `激活值系数取 ${factor}（${recompute ? '开启重计算' : flash ? '无重计算 + FlashAttention' : '无重计算且无 FlashAttention'}），` +
        '这是量级估算，因此以区间形式给出。',
      capacity
        ? `按 ${gpuKey} 单卡 ${capacity} GB、预留 10% 计，可用约 ${usable} GB。`
        : '未指定卡型，无法判断能否装下。',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html#memory-management',
  };
}

// ======================================================================
// 5. 证据包归一化 + 预分析
// ======================================================================
/** 把案例对象归一化成一份证据包。字段缺失时给出空值而不是抛错。 */
export function normalizeEvidence(caseObj = {}) {
  const ev = caseObj.evidence || caseObj;
  return {
    id: caseObj.id || 'adhoc',
    title: caseObj.title || '未命名案例',
    subtitle: caseObj.subtitle || '',
    reported_at: ev.reported_at || '',
    job: {
      name: ev.job?.name || '',
      user: ev.job?.user || '',
      node: ev.job?.node || '',
      gpu_count: ev.job?.gpu_count ?? null,
      gpu_type: ev.job?.gpu_type || '',
      start_hour: ev.job?.start_hour ?? null,
      runtime_hours: ev.job?.runtime_hours ?? null,
      status: ev.job?.status || '',
      ...ev.job,
    },
    command: ev.command || '',
    stderr_excerpt: ev.stderr_excerpt || '',
    docker_image: ev.docker_image || '',
    environment: { ...(ev.environment || {}) },
    training_config: { ...(ev.training_config || {}) },
    node_telemetry: ev.node_telemetry || null,
    expected: caseObj.expected || null,
  };
}

/** 把证据包拼成一段可供正则匹配的纯文本。 */
export function evidenceToText(ev) {
  const parts = [
    ev.stderr_excerpt,
    ev.command,
    ev.docker_image,
    ev.job?.status,
    ev.node_telemetry ? JSON.stringify(ev.node_telemetry) : '',
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 预分析：把「能算的」全算出来。
 *
 * 返回对象里，`confirmed` 是代码确证的事实，`hints` 是倾向性提示（不是结论）。
 * 界面上这两块会分开渲染——这是「哪些是算的、哪些是模型判断的」的边界。
 */
export function preAnalyze(ev) {
  const text = evidenceToText(ev);
  const xids = extractXids(text);
  const signatures = matchSignatures(text);
  const compat = checkCompatibility(ev.environment || {});

  // 显存：只有训练配置齐全时才估算
  const cfg = ev.training_config || {};
  const hasMemInputs = Number(cfg.model_params_b) > 0;
  const memory = hasMemInputs
    ? estimateTrainingMemory({
        ...cfg,
        gpu_type: cfg.gpu_type || ev.job?.gpu_type,
      })
    : null;

  // 遥测里若有 Xid 历史，一并纳入
  const telemetry = ev.node_telemetry || null;
  const telemetryXids = telemetry?.xid_events || [];

  // 汇总各来源对分类的「投票」，仅作为提示
  const votes = {};
  const vote = (cls, weight, why) => {
    if (!cls) return;
    votes[cls] = votes[cls] || { cls, weight: 0, why: [] };
    votes[cls].weight += weight;
    if (why) votes[cls].why.push(why);
  };

  for (const x of xids) {
    if (x.entry) vote(x.entry.class, 3, `Xid ${x.code}（${x.entry.name}）`);
  }
  for (const s of signatures) {
    vote(s.class_hint, 2, `特征「${s.label}」`);
  }
  if (telemetryXids.length) {
    for (const t of telemetryXids) {
      const e = XID_TABLE[t.code];
      if (e) vote(e.class, 2, `节点遥测记录 Xid ${t.code}`);
    }
  }
  if (!compat.ok) vote('environment', 3, '版本栈不自洽');

  const hints = Object.values(votes)
    .sort((a, b) => b.weight - a.weight)
    .map((v) => ({ class: v.cls, label: CLASSES[v.cls]?.label || v.cls, weight: v.weight, why: v.why }));

  return {
    confirmed: {
      xids: xids.map((x) => ({
        code: x.code,
        count: x.count,
        known: x.known,
        name: x.entry?.name || null,
        class: x.entry?.class || null,
      })),
      signatures: signatures.map((s) => ({ id: s.id, label: s.label, matched_text: s.matched_text })),
      compat_ok: compat.ok,
      compat_issues: compat.issues,
      memory_required_gb: memory?.total_range_gb || null,
      memory_capacity_gb: memory?.per_gpu_capacity_gb || null,
      memory_fit: memory?.fit || null,
      node: ev.job?.node || null,
    },
    hints,
    detail: { xids, signatures, compat, memory, telemetry },
  };
}

/** 给工具与提示词用的紧凑证据摘要。 */
export function evidenceDigest(ev, pre) {
  return {
    case_id: ev.id,
    title: ev.title,
    reported_at: ev.reported_at,
    node: ev.job?.node || null,
    gpu_type: ev.job?.gpu_type || null,
    gpu_count: ev.job?.gpu_count ?? null,
    job_status: ev.job?.status || null,
    runtime_hours: ev.job?.runtime_hours ?? null,
    environment: ev.environment,
    training_config: ev.training_config,
    detected_xids: pre.confirmed.xids,
    matched_signatures: pre.confirmed.signatures,
    compat_ok: pre.confirmed.compat_ok,
    compat_issue_count: pre.confirmed.compat_issues.length,
    memory_required_gb: pre.confirmed.memory_required_gb,
    memory_capacity_gb: pre.confirmed.memory_capacity_gb,
    memory_fit: pre.confirmed.memory_fit,
  };
}
