/** Deterministic, offline pre-analysis extracts log facts, compatibility checks, and memory estimates before model inference. */
/** Keep confirmed facts separate from classification hints. */

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

/** Normalize a version string to numeric components. */
export function parseVersion(v) {
  const m = String(v ?? '').match(/\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split('.').map((n) => Number(n));
}

/** Compare versions, padding missing components with zero. */
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

/** Return the CUDA major.minor version. */
export function cudaShort(v) {
  const p = parseVersion(v);
  if (!p) return null;
  return p.length >= 2 ? `${p[0]}.${p[1]}` : String(p[0]);
}

/** Return the torch major.minor version. */
export function torchShort(v) {
  const p = parseVersion(v);
  if (!p) return null;
  return p.length >= 2 ? `${p[0]}.${p[1]}` : String(p[0]);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** Recognize supported Xid formats from kernel logs. */
const XID_PATTERNS = [
  /NVRM:\s*Xid\s*\([^)]*\)\s*:\s*(\d{1,3})/gi,
  /\bXid\s*[:=]?\s*(\d{1,3})\b/gi,
  /\bxid\s*[:=]\s*(\d{1,3})\b/gi,
];

/** Count Xids in encounter order; retain unknown codes with a null entry. */
export function extractXids(text) {
  const found = new Map();
  for (const re of XID_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = Number(m[1]);

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

/** Return literal signature matches without drawing a conclusion. */
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

/** Validate driver, CUDA runtime, and torch compatibility; errors block use and warnings require manual checks. */
export function checkCompatibility(env = {}) {
  const issues = [];
  const info = {
    driver: env.driver || null,
    cuda_runtime: cudaShort(env.cuda_runtime || env.cuda),
    torch: torchShort(env.torch),
    nccl: env.nccl || null,
  };

  if (info.torch && info.cuda_runtime) {
    const supported = TORCH_CUDA[info.torch];
    if (!supported) {
      issues.push({
        level: 'warn',
        code: 'torch_version_unknown',
        message: `PyTorch ${info.torch} is absent from the version snapshot, automatic validation is unavailable.`,
        fix: 'Check the official support list for this version.',
      });
    } else if (!supported.includes(info.cuda_runtime)) {
      issues.push({
        level: 'error',
        code: 'torch_cuda_mismatch',
        message:
          `Official PyTorch ${info.torch} wheels support CUDA ${supported.join(' / ')}, ` +
          `but the current runtime is CUDA ${info.cuda_runtime}.`,
        fix: `Use a cu${info.cuda_runtime.replace('.', '')} wheel or switch CUDA to ${supported.join('/')}.`,
      });
    }
  }

  if (info.driver && info.cuda_runtime) {
    const need = CUDA_DRIVER_MIN[info.cuda_runtime];
    if (!need) {
      issues.push({
        level: 'warn',
        code: 'cuda_version_unknown',
        message: `The snapshot has no minimum driver requirement for CUDA ${info.cuda_runtime}; automatic validation is unavailable.`,
        fix: 'Check the minimum driver in CUDA Toolkit Release Notes.',
      });
    } else if (compareVersions(info.driver, need) < 0) {
      issues.push({
        level: 'error',
        code: 'driver_too_old',
        message:
          `Driver ${info.driver} is below the minimum ${need} for CUDA ${info.cuda_runtime}; ` +
          `this runtime cannot start.`,
        fix: `Upgrade the driver to ${need} or later, or use a framework CUDA version compatible with the current driver.`,
      });
    }
  }

  if (info.driver && info.cuda_runtime) {
    const ceiling = driverCeiling(info.driver);
    if (ceiling && compareVersions(info.cuda_runtime, ceiling) > 0) {
      issues.push({
        level: 'error',
        code: 'driver_below_cuda',
        message:
          `Driver ${info.driver} supports up to CUDA ${ceiling}, ` +
          `but the runtime requires CUDA ${info.cuda_runtime}.`,
        fix: `Upgrade the driver or lower the CUDA runtime to ${ceiling}.`,
      });
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), info, issues };
}

/** Find the maximum supported CUDA version for a driver. */
export function driverCeiling(driver) {
  for (const row of DRIVER_CUDA_CEILING) {
    if (compareVersions(driver, row.driver_min) >= 0) return row.cuda;
  }
  return null;
}

/** Compute model-state memory from precision and sharding; report activation estimates as low/mid/high ranges with CUDA overhead and a 10% capacity reserve. */
export function estimateTrainingMemory(spec = {}) {
  const paramsB = Number(spec.model_params_b ?? spec.params_b ?? 0);
  if (!(paramsB > 0)) return { error: 'model_params_b must be positive (billions of parameters)' };

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

  const masterBytes = isFp32 ? 0 : P * 4;

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

  const batch = Number(spec.batch_size ?? spec.batch ?? 1);
  const seq = Number(spec.seq_len ?? spec.seq ?? 2048);
  const hidden = Number(spec.hidden_size ?? 4096);
  const layers = Number(spec.num_layers ?? spec.layers ?? 32);

  //

  let factor;
  if (recompute) factor = 1.5;
  else if (flash) factor = 5;
  else factor = 30;

  const actBase = batch * seq * hidden * layers * pbytes * factor;

  const actLow = actBase * 0.75;
  const actMid = actBase;
  const actHigh = actBase * 1.3;

  const overheadGb = 1.0;

  const g = (b) => round1(b / GB);
  const statesGb = g(statesBytes);
  const totalLow = round1(statesGb + g(actLow) + overheadGb);
  const totalMid = round1(statesGb + g(actMid) + overheadGb);
  const totalHigh = round1(statesGb + g(actHigh) + overheadGb);

  const gpuKey = GPU_ALIASES[String(spec.gpu_type || '').toLowerCase()] || spec.gpu_type;
  const capacity = GPU_MEMORY_GB[gpuKey] ?? null;
  let fit = null;
  let usable = null;
  if (capacity) {

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
      'Model states (parameters, gradients, optimizer, master weights) use the standard 16-byte-per-parameter accounting.',
      `Activation factor: ${factor} (${recompute ? 'recomputation enabled' : flash ? 'FlashAttention without recomputation' : 'no recomputation or FlashAttention'}). ` +
        'Activations are an estimate and are reported as a range.',
      capacity
        ? `${gpuKey}: ${capacity} GB per GPU, approximately ${usable} GB usable after a 10% reserve.`
        : 'GPU type is unspecified; capacity fit cannot be determined.',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html#memory-management',
  };
}

/** Normalize missing evidence fields to empty values without throwing. */
export function normalizeEvidence(caseObj = {}) {
  const ev = caseObj.evidence || caseObj;
  return {
    id: caseObj.id || 'adhoc',
    title: caseObj.title || 'Untitled case',
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

/** Join evidence fields for literal log recognition. */
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

/** Keep confirmed facts separate from classification hints. */
export function preAnalyze(ev) {
  const text = evidenceToText(ev);
  const xids = extractXids(text);
  const signatures = matchSignatures(text);
  const compat = checkCompatibility(ev.environment || {});

  const cfg = ev.training_config || {};
  const hasMemInputs = Number(cfg.model_params_b) > 0;
  const memory = hasMemInputs
    ? estimateTrainingMemory({
        ...cfg,
        gpu_type: cfg.gpu_type || ev.job?.gpu_type,
      })
    : null;

  const telemetry = ev.node_telemetry || null;
  const telemetryXids = telemetry?.xid_events || [];

  const votes = {};
  const vote = (cls, weight, why) => {
    if (!cls) return;
    votes[cls] = votes[cls] || { cls, weight: 0, why: [] };
    votes[cls].weight += weight;
    if (why) votes[cls].why.push(why);
  };

  for (const x of xids) {
    if (x.entry) vote(x.entry.class, 3, `Xid ${x.code} (${x.entry.name})`);
  }
  for (const s of signatures) {
    vote(s.class_hint, 2, `Signature: ${s.label}`);
  }
  if (telemetryXids.length) {
    for (const t of telemetryXids) {
      const e = XID_TABLE[t.code];
      if (e) vote(e.class, 2, `Node telemetry recorded Xid ${t.code}`);
    }
  }
  if (!compat.ok) vote('environment', 3, 'Software stack is incompatible');

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

/** Build a compact evidence digest for tools and prompts. */
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

/** Keep confirmed facts separate from classification hints. */
export function ruleBasedTriage(ev, pre = null) {
  const p = pre || preAnalyze(ev);
  const hints = p.hints || [];
  const top = hints[0] || null;
  const cls = top ? top.class : 'undetermined';

  return {
    method: 'rule-baseline',
    class: cls,

    should_rma: cls === 'hardware',
    confidence: top ? Math.min(0.85, 0.35 + 0.05 * top.weight) : 0.1,
    basis: top ? top.why.slice() : [],
    note: 'Select the highest-voted class; recommend repair only for hardware. This baseline does not analyze trends or causal chains.',
  };
}

/** Compare classification and should_rma for benchmark reporting. */
export function compareWithExpected(result, expected) {
  if (!expected) return null;
  const classOk = result.class === expected.class;
  const rmaOk = Boolean(result.should_rma) === Boolean(expected.should_rma);
  return {
    class_ok: classOk,
    rma_ok: rmaOk,
    pass: classOk && rmaOk,
    got: { class: result.class, should_rma: Boolean(result.should_rma) },
    want: { class: expected.class, should_rma: Boolean(expected.should_rma) },
  };
}
