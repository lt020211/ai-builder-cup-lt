/**
 * AI 可调用的工具集。
 *
 * 这是本项目的关键设计：AI 不是「读一段数字然后写一段话」，而是**先调用工具取数、
 * 再基于工具返回值下结论**。工具返回的所有数字都来自确定性代码，AI 无法凭空生成。
 *
 * 本文件是 src/tools.py 的浏览器端移植。
 *
 * 工具清单：
 *     query_metrics      按条件查节点指标
 *     estimate_carbon    估算某电耗在某小时的碳排，并给出最优时段
 *     simulate_defer     模拟「把某节点的负载挪到另一个小时」的碳排变化
 *     propose_action     登记一条优化建议（前端据此渲染「接受/拒绝」按钮）
 */

import * as carbon from './carbon.js';

// ---------------------------------------------------------------- 工具声明
// 格式遵循 Gemini functionDeclarations
export const TOOL_SPECS = [
  {
    name: 'query_metrics',
    description:
      '按条件查询集群节点的算力浪费指标。不传参数则返回浪费金额最高的若干节点。' +
      '每次分析请先调用本工具取数，再下结论。',
    parameters: {
      type: 'object',
      properties: {
        cloud: { type: 'string', description: '云厂商标识，如 cloud-a' },
        gpu_type: { type: 'string', description: '卡型，如 H800' },
        pattern: {
          type: 'string',
          description: '浪费模式：over_request / idle / low_util',
        },
        limit: { type: 'integer', description: '返回条数上限，默认 10' },
      },
    },
  },
  {
    name: 'estimate_carbon',
    description:
      '估算给定电耗在指定小时的碳排，并返回全天碳强度最低与最高的时段。' +
      '用于判断「什么时候跑更低碳」。',
    parameters: {
      type: 'object',
      properties: {
        energy_kwh: { type: 'number', description: '电耗，单位 kWh' },
        hour: { type: 'integer', description: '小时（0-23）' },
        region: {
          type: 'string',
          description: '电网区域：north / east / south / southwest，缺省 default',
        },
      },
      required: ['energy_kwh', 'hour'],
    },
  },
  {
    name: 'simulate_defer',
    description:
      '模拟把某个节点的负载从当前时段挪到 target_hour 运行，碳排会变化多少。' +
      '电耗不变，只改变碳强度。用于给出「推迟到几点」的具体建议。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点标识，如 node-a02' },
        target_hour: { type: 'integer', description: '目标小时（0-23）' },
        region: { type: 'string', description: '电网区域，缺省 default' },
      },
      required: ['node', 'target_hour'],
    },
  },
  {
    name: 'propose_action',
    description:
      '登记一条优化建议。每给出一条建议都必须调用本工具登记，' +
      '否则该建议不会出现在交付给用户的决策清单里。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '动作名称，不超过 20 字' },
        detail: { type: 'string', description: '具体怎么做，一到两句话' },
        expected_cost_recovery_cny: {
          type: 'number',
          description: '预计可回收金额（元）',
        },
        expected_carbon_reduction_kg: {
          type: 'number',
          description: '预计可减少碳排（kgCO2e）',
        },
        effort: { type: 'string', description: '实施成本：低 / 中 / 高' },
        evidence: { type: 'string', description: '支撑该建议的具体节点或数字' },
      },
      required: ['title', 'detail'],
    },
  },
];

// ---------------------------------------------------------------- 执行状态
/** 承载一次分析会话的数据与产出。 */
export class ToolState {
  constructor(records, findings, summary) {
    this.records = records;
    this.findings = findings;
    this.summary = summary;
    this.actions = [];
    this._byNode = {};
    for (const r of records) this._byNode[r.node] = r;
  }

  queryMetrics({ cloud = null, gpu_type = null, pattern = null, limit = 10 } = {}) {
    let rows = this.records;
    if (cloud) rows = rows.filter((r) => r.cloud === cloud);
    if (gpu_type) rows = rows.filter((r) => r.gpu_type === gpu_type);
    if (pattern) {
      rows = rows.filter(
        (r) => pattern === r.dominant_pattern || r.patterns.includes(pattern),
      );
    }

    let cap;
    const n = Number(limit);
    cap = Number.isFinite(n) ? Math.max(1, Math.min(Math.trunc(n), 50)) : 10;

    rows = rows
      .slice()
      .sort((a, b) => b.waste_cost_cny - a.waste_cost_cny)
      .slice(0, cap);

    const fields = [
      'cloud',
      'node',
      'gpu_type',
      'requested_cards',
      'used_cards',
      'hours',
      'avg_util_pct',
      'start_hour',
      'waste_card_hours',
      'waste_cost_cny',
      'waste_energy_kwh',
      'waste_carbon_kg',
      'workload_energy_kwh',
      'dominant_pattern',
      'pattern_label',
      'severity',
    ];
    // 注意：matched 在 Python 里是**截断后**的行数（先切片再 len），保持一致
    return {
      matched: rows.length,
      nodes: rows.map((r) => Object.fromEntries(fields.map((k) => [k, r[k]]))),
      total_waste_cost_cny: round2(rows.reduce((acc, r) => acc + r.waste_cost_cny, 0)),
    };
  }

  estimateCarbon({ energy_kwh, hour, region = null } = {}) {
    const energy = Number(energy_kwh);
    if (!Number.isFinite(energy)) return { error: 'energy_kwh 必须是数字' };
    const hourI = carbon.normalizeHour(hour);
    return {
      energy_kwh: energy,
      hour: hourI,
      region: region || 'default',
      intensity_kg_per_kwh: carbon.intensityKgPerKwh(hourI, region),
      carbon_kg: carbon.carbonKg(energy, hourI, region),
      best_hour: carbon.bestHour(),
      worst_hour: carbon.worstHour(),
      best_hour_intensity_kg_per_kwh: carbon.intensityKgPerKwh(carbon.bestHour(), region),
    };
  }

  simulateDefer({ node, target_hour, region = null } = {}) {
    const record = this._byNode[String(node)];
    if (!record) {
      return {
        error: `找不到节点 ${node}`,
        available_nodes: Object.keys(this._byNode).sort().slice(0, 20),
      };
    }
    const result = carbon.deferImpact(
      record.workload_energy_kwh,
      record.start_hour,
      target_hour,
      region,
    );
    result.node = record.node;
    result.gpu_type = record.gpu_type;
    result.current_start_hour = record.start_hour;
    result.note =
      '仅考虑运行时段变化带来的碳强度差异，电耗本身不变；' +
      '未计入任务时限约束，需人工确认可延后性。';
    return result;
  }

  proposeAction({
    title,
    detail,
    expected_cost_recovery_cny = 0,
    expected_carbon_reduction_kg = 0,
    effort = '中',
    evidence = '',
  } = {}) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? round2(n) : 0.0;
    };
    const action = {
      id: `A${this.actions.length + 1}`,
      title: String(title).slice(0, 60),
      detail: String(detail),
      expected_cost_recovery_cny: num(expected_cost_recovery_cny),
      expected_carbon_reduction_kg: num(expected_carbon_reduction_kg),
      effort: String(effort),
      evidence: String(evidence),
    };
    this.actions.push(action);
    return { registered: action.id, total_actions: this.actions.length };
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- 分发
const HANDLERS = {
  query_metrics: ['queryMetrics', ['cloud', 'gpu_type', 'pattern', 'limit']],
  estimate_carbon: ['estimateCarbon', ['energy_kwh', 'hour', 'region']],
  simulate_defer: ['simulateDefer', ['node', 'target_hour', 'region']],
  propose_action: [
    'proposeAction',
    [
      'title',
      'detail',
      'expected_cost_recovery_cny',
      'expected_carbon_reduction_kg',
      'effort',
      'evidence',
    ],
  ],
};

/** 执行一次工具调用。参数名不匹配时只取认识的字段，避免模型传错键导致崩溃。 */
export function dispatchTool(name, args, state) {
  const entry = HANDLERS[name];
  if (!entry) {
    return { error: `未知工具 ${name}`, available_tools: Object.keys(HANDLERS).sort() };
  }
  const [methodName, allowed] = entry;
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (allowed.includes(k)) clean[k] = v;
  }
  try {
    return state[methodName](clean);
  } catch (exc) {
    // 工具异常不应中断整个会话
    return { error: `${(exc && exc.name) || 'Error'}: ${(exc && exc.message) || exc}` };
  }
}
