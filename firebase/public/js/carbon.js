/**
 * 电网碳强度模型：把「什么时候跑」纳入碳排计算。
 *
 * 本文件是 src/carbon.py 的浏览器端逐行移植，算法与常量完全一致。
 *
 * 为什么需要它：同样的电耗，在不同时段跑，碳排不一样——正午光伏出力高峰时碳强度最低，
 * 晚高峰火电调峰时最高。这是「碳感知调度」的物理依据。
 *
 * ⚠️ 本模块的时段曲线与区域系数是公开资料的**简化近似**，不是实测数据。
 *    接入真实碳强度数据源（如 Electricity Maps）后可整体替换，对外接口保持不变。
 */

/** 全国电网平均排放因子（kgCO2e/kWh） */
export const BASE_CARBON_FACTOR_KG_PER_KWH = 0.581;

/** 24 小时相对强度，全天均值为 1.0。
 *  依据：光伏出力高峰在正午 → 碳强度最低（0.82）；晚高峰火电调峰 → 最高（1.10）。 */
export const HOURLY_PROFILE = [
  0.92, 0.90, 0.88, 0.87, 0.86, 0.87, 0.90, 0.95,
  1.00, 1.02, 0.98, 0.90, 0.84, 0.82, 0.83, 0.87,
  0.92, 0.98, 1.06, 1.10, 1.08, 1.04, 1.00, 0.96,
];

/** 区域电网结构差异带来的系数（火电占比高的区域系数更大） */
export const REGION_FACTORS = {
  default: 1.0,
  north: 1.05,
  east: 1.0,
  south: 0.85,
  southwest: 0.55,
};

/**
 * Python 风格的四舍五入（banker's rounding）。
 *
 * 为什么要自己实现：JS 的 Math.round 是「.5 一律进位」，而 Python 的 round 是
 * 「.5 取偶」。本文件是 Python 的移植，只有对齐这个细节，同一份输入才能得到
 * 与后端完全一致的输出——否则前端与测试会对不上，排查时容易误判。
 */
export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const m = 10 ** digits;
  const v = value * m;
  const f = Math.floor(v);
  const diff = v - f;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) {
    r = f % 2 === 0 ? f : f + 1;
  } else {
    r = Math.round(v);
  }
  return r / m;
}

export function normalizeHour(hour) {
  const n = Number(hour);
  if (!Number.isFinite(n)) return 0;
  // Python: int(round(float(hour))) % 24 —— 注意负数取模也要落在 0..23
  return ((pyRound(n, 0) % 24) + 24) % 24;
}

/** 返回该小时的相对碳强度系数（全天均值为 1.0）。 */
export function hourlyFactor(hour) {
  return HOURLY_PROFILE[normalizeHour(hour)];
}

export function regionFactor(region) {
  const key = region || 'default';
  return Object.prototype.hasOwnProperty.call(REGION_FACTORS, key)
    ? REGION_FACTORS[key]
    : REGION_FACTORS.default;
}

/** 某小时某区域的电网碳强度（kgCO2e/kWh）。 */
export function intensityKgPerKwh(hour, region = 'default') {
  return pyRound(BASE_CARBON_FACTOR_KG_PER_KWH * hourlyFactor(hour) * regionFactor(region), 4);
}

export function carbonKg(energyKwh, hour, region = 'default') {
  const e = Number(energyKwh);
  return pyRound(Math.max(Number.isFinite(e) ? e : 0, 0) * intensityKgPerKwh(hour, region), 2);
}

/** 全天碳强度最低的小时。 */
export function bestHour() {
  let best = 0;
  for (let h = 1; h < 24; h += 1) {
    if (HOURLY_PROFILE[h] < HOURLY_PROFILE[best]) best = h;
  }
  return best;
}

/** 全天碳强度最高的小时。 */
export function worstHour() {
  let worst = 0;
  for (let h = 1; h < 24; h += 1) {
    if (HOURLY_PROFILE[h] > HOURLY_PROFILE[worst]) worst = h;
  }
  return worst;
}

/**
 * 把一段固定电耗从 fromHour 挪到 toHour，碳排如何变化。
 * toHour 缺省时给出全天最优时段（碳强度最低的小时）。
 */
export function deferImpact(energyKwh, fromHour, toHour = null, region = 'default') {
  const src = normalizeHour(fromHour);
  const dst = toHour === null || toHour === undefined ? bestHour() : normalizeHour(toHour);

  const before = carbonKg(energyKwh, src, region);
  const after = carbonKg(energyKwh, dst, region);
  const reduction = pyRound(before - after, 2);
  const pct = before > 0 ? pyRound((100.0 * reduction) / before, 2) : 0.0;
  const e = Number(energyKwh);

  return {
    energy_kwh: pyRound(Math.max(Number.isFinite(e) ? e : 0, 0), 2),
    region: region || 'default',
    from_hour: src,
    to_hour: dst,
    intensity_from_kg_per_kwh: intensityKgPerKwh(src, region),
    intensity_to_kg_per_kwh: intensityKgPerKwh(dst, region),
    carbon_before_kg: before,
    carbon_after_kg: after,
    carbon_reduction_kg: reduction,
    carbon_reduction_pct: pct,
    energy_unchanged: true,
  };
}

/** 返回全天碳强度曲线，供前端画图或 AI 参考。 */
export function profileSnapshot() {
  return {
    base_factor_kg_per_kwh: BASE_CARBON_FACTOR_KG_PER_KWH,
    hourly_factor: HOURLY_PROFILE.slice(),
    best_hour: bestHour(),
    worst_hour: worstHour(),
    note: '相对强度，全天均值为 1.0；简化近似，非实测数据',
  };
}
