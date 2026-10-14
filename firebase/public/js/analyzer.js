/**
 * 算力浪费识别与折算模型。
 *
 * 本文件是 src/analyzer.py 的浏览器端移植。纯计算层，不依赖网络与 AI。
 *
 * 简化模型的全部假设（详见 docs/architecture.md）：
 *
 * 1. 浪费卡时 = 申请未用卡时 + 低效折算卡时
 *    - 申请未用卡时 = max(申请卡数 - 实际使用卡数, 0) x 时长
 *    - 低效折算卡时 = 使用卡数 x 时长 x (1 - 平均利用率)，仅当平均利用率 < 30%
 * 2. 浪费电耗 = 浪费卡时 x 单卡 TDP x 空转功率系数 / 1000
 *    空转功率系数取 0.25（业界经验值：闲置 GPU 功率约为 TDP 的 20%~30%）
 * 3. 浪费电费 = 浪费电耗 x 工业电价
 * 4. 浪费碳排 = 浪费电耗 x 全国电网平均排放因子
 */

import { pyRound } from './carbon.js';

export const PRICE_PER_KWH_CNY = 0.7;
export const CARBON_FACTOR_KG_PER_KWH = 0.581;
export const IDLE_POWER_RATIO = 0.25;
export const LOW_UTIL_THRESHOLD_PCT = 30.0;
export const IDLE_UTIL_THRESHOLD_PCT = 5.0;
export const TREE_ANNUAL_CARBON_KG = 18.0;

export const GPU_SPECS = {
  H800: { tdp_w: 700, price_per_card_hour_cny: 24.0 },
  H100: { tdp_w: 700, price_per_card_hour_cny: 28.0 },
  A100: { tdp_w: 400, price_per_card_hour_cny: 15.0 },
  V100: { tdp_w: 300, price_per_card_hour_cny: 8.0 },
  H20: { tdp_w: 400, price_per_card_hour_cny: 12.0 },
};
export const DEFAULT_SPEC = { tdp_w: 400.0, price_per_card_hour_cny: 15.0 };

/**
 * 利用率到功耗占比的线性近似。
 *
 * 利用率 0% 时取空转功率系数（0.25），100% 时取满功耗（1.0），中间线性插值。
 * 真实 GPU 功耗对利用率并非严格线性，此处为简化模型；因为是单调映射，
 * 不改变「利用率越高越费电」的结论方向。
 */
export function activePowerRatio(utilPct) {
  const u = Math.max(Math.min(utilPct, 100.0), 0.0);
  return IDLE_POWER_RATIO + (1.0 - IDLE_POWER_RATIO) * (u / 100.0);
}

export const PATTERN_LABELS = {
  over_request: '超额申请',
  idle: '长期空转',
  low_util: '低效运行',
  efficient: '使用充分',
};

export const SEVERITY_HIGH_COST = 5000.0;
export const SEVERITY_MEDIUM_COST = 1000.0;

function toFloat(value, fallback = 0.0) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  const n = toFloat(value, NaN);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function severity(costCny) {
  if (costCny >= SEVERITY_HIGH_COST) return 'high';
  if (costCny >= SEVERITY_MEDIUM_COST) return 'medium';
  return 'low';
}

/** 对单条算力记录做浪费识别与折算。 */
export function analyzeRecord(rec) {
  const cloud = String(rec.cloud || 'unknown');
  const node = String(rec.node || 'unknown');
  const gpuType = String(rec.gpu_type || 'unknown');
  const spec = GPU_SPECS[gpuType] || DEFAULT_SPEC;

  const requested = Math.max(toInt(rec.requested_cards), 0);
  const used = Math.max(toInt(rec.used_cards), 0);
  const hours = Math.max(toFloat(rec.hours), 0.0);
  const util = Math.min(Math.max(toFloat(rec.avg_util_pct), 0.0), 100.0);
  // Python: _to_int(rec.get("start_hour"), 19) % 24 —— 缺省 19 点（晚高峰）
  const startHour = ((toInt(rec.start_hour, 19) % 24) + 24) % 24;

  const unusedCards = Math.max(requested - used, 0);
  const unusedCardHours = unusedCards * hours;

  let lowEffCardHours = 0.0;
  if (used > 0 && util < LOW_UTIL_THRESHOLD_PCT) {
    lowEffCardHours = used * hours * (1.0 - util / 100.0);
  }

  const wasteCardHours = unusedCardHours + lowEffCardHours;

  const patterns = [];
  if (unusedCards > 0) patterns.push('over_request');
  if (used > 0 && util < IDLE_UTIL_THRESHOLD_PCT) {
    patterns.push('idle');
  } else if (used > 0 && util < LOW_UTIL_THRESHOLD_PCT) {
    patterns.push('low_util');
  }
  if (patterns.length === 0) patterns.push('efficient');

  let dominant;
  if (patterns.includes('over_request')) dominant = 'over_request';
  else if (patterns.includes('idle')) dominant = 'idle';
  else if (patterns.includes('low_util')) dominant = 'low_util';
  else dominant = 'efficient';

  const energyKwh = (wasteCardHours * spec.tdp_w * IDLE_POWER_RATIO) / 1000.0;
  const workloadEnergyKwh =
    (used * hours * spec.tdp_w * activePowerRatio(util)) / 1000.0;
  const costCny = wasteCardHours * spec.price_per_card_hour_cny;
  const carbonKg = energyKwh * CARBON_FACTOR_KG_PER_KWH;

  const reservedCardHours = requested * hours;
  const efficiency =
    reservedCardHours > 0
      ? Math.max(0.0, 100.0 * (1.0 - wasteCardHours / reservedCardHours))
      : 100.0;

  return {
    cloud,
    node,
    gpu_type: gpuType,
    requested_cards: requested,
    used_cards: used,
    hours: pyRound(hours, 2),
    avg_util_pct: pyRound(util, 2),
    start_hour: startHour,
    unused_card_hours: pyRound(unusedCardHours, 2),
    low_eff_card_hours: pyRound(lowEffCardHours, 2),
    waste_card_hours: pyRound(wasteCardHours, 2),
    waste_cost_cny: pyRound(costCny, 2),
    waste_energy_kwh: pyRound(energyKwh, 2),
    workload_energy_kwh: pyRound(workloadEnergyKwh, 2),
    waste_carbon_kg: pyRound(carbonKg, 2),
    efficiency_pct: pyRound(efficiency, 2),
    patterns,
    dominant_pattern: dominant,
    pattern_label: PATTERN_LABELS[dominant],
    severity: severity(costCny),
  };
}

/** 按指定字段分组求和。 */
function groupSum(rows, key) {
  const out = {};
  for (const r of rows) {
    if (!out[r[key]]) {
      out[r[key]] = {
        records: 0,
        waste_card_hours: 0.0,
        waste_cost_cny: 0.0,
        waste_energy_kwh: 0.0,
        waste_carbon_kg: 0.0,
      };
    }
    const bucket = out[r[key]];
    bucket.records += 1;
    bucket.waste_card_hours += r.waste_card_hours;
    bucket.waste_cost_cny += r.waste_cost_cny;
    bucket.waste_energy_kwh += r.waste_energy_kwh;
    bucket.waste_carbon_kg += r.waste_carbon_kg;
  }
  for (const bucket of Object.values(out)) {
    for (const field of [
      'waste_card_hours',
      'waste_cost_cny',
      'waste_energy_kwh',
      'waste_carbon_kg',
    ]) {
      bucket[field] = pyRound(bucket[field], 2);
    }
  }
  return out;
}

/** 对一批算力记录做整体审计，返回汇总、明细与分组统计。 */
export function analyzeBatch(records, window = null) {
  const analyses = records.map(analyzeRecord);

  const findings = analyses
    .filter((a) => a.waste_card_hours > 0)
    .sort((a, b) => b.waste_cost_cny - a.waste_cost_cny);

  const sum = (fn) => analyses.reduce((acc, a) => acc + fn(a), 0);
  const totalWaste = sum((a) => a.waste_card_hours);
  const totalCost = sum((a) => a.waste_cost_cny);
  const totalEnergy = sum((a) => a.waste_energy_kwh);
  const totalCarbon = sum((a) => a.waste_carbon_kg);
  const totalReserved = sum((a) => a.requested_cards * a.hours);
  const totalUsed = sum((a) => a.used_cards * a.hours);

  const byPattern = {};
  for (const a of analyses) {
    if (a.dominant_pattern === 'efficient') continue;
    if (!byPattern[a.dominant_pattern]) {
      byPattern[a.dominant_pattern] = {
        label: PATTERN_LABELS[a.dominant_pattern],
        records: 0,
        waste_cost_cny: 0.0,
      };
    }
    byPattern[a.dominant_pattern].records += 1;
    byPattern[a.dominant_pattern].waste_cost_cny = pyRound(
      byPattern[a.dominant_pattern].waste_cost_cny + a.waste_cost_cny,
      2,
    );
  }

  const summary = {
    generated_at: localIsoSeconds(),
    window: window || '未指定',
    record_count: analyses.length,
    total_reserved_card_hours: pyRound(totalReserved, 2),
    total_used_card_hours: pyRound(totalUsed, 2),
    total_waste_card_hours: pyRound(totalWaste, 2),
    waste_ratio_pct: totalReserved ? pyRound((100.0 * totalWaste) / totalReserved, 2) : 0.0,
    total_waste_cost_cny: pyRound(totalCost, 2),
    total_waste_energy_kwh: pyRound(totalEnergy, 2),
    total_waste_carbon_kg: pyRound(totalCarbon, 2),
    carbon_tree_equivalent: pyRound(totalCarbon / TREE_ANNUAL_CARBON_KG, 1),
    reclaimable_h800_card_hours: pyRound(
      totalCost / GPU_SPECS.H800.price_per_card_hour_cny,
      1,
    ),
    high_severity_count: findings.filter((a) => a.severity === 'high').length,
    model_assumptions: {
      price_per_kwh_cny: PRICE_PER_KWH_CNY,
      carbon_factor_kg_per_kwh: CARBON_FACTOR_KG_PER_KWH,
      idle_power_ratio: IDLE_POWER_RATIO,
      low_util_threshold_pct: LOW_UTIL_THRESHOLD_PCT,
      idle_util_threshold_pct: IDLE_UTIL_THRESHOLD_PCT,
    },
  };

  return {
    summary,
    findings: findings.slice(0, 20),
    records: analyses,
    by_cloud: groupSum(analyses, 'cloud'),
    by_gpu_type: groupSum(analyses, 'gpu_type'),
    by_pattern: byPattern,
  };
}

/** 生成本地时区的 ISO 字符串（秒精度），对齐 Python 的 isoformat(timespec="seconds")。 */
function localIsoSeconds() {
  const d = new Date();
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}
