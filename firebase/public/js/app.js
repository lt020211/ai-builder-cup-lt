/**
 * 界面装配层：把「本地确定性计算」与「AI 诊断」串起来，并渲染结果。
 *
 * 这是原来 Flask 应用里 app.py（路由）+ templates/index.html（脚本）两部分的合并。
 * 合并的原因：现在没有后端了——审计计算在浏览器里跑，Gemini 由 Firebase AI Logic
 * 直连，所以「取数据 → 算 → 调模型 → 渲染」全在同一条 async 流程里。
 */

import { analyzeBatch } from './analyzer.js';
import * as carbon from './carbon.js';
import { DEFAULT_MODEL, diagnose } from './ai.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 0) =>
  Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d });
/** 固定一位小数。用于碳排量：63.03 应显示「63.0」而不是「63」，与口径说明一致。 */
const fmt1 = (n) =>
  Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const money = (n) => `¥${fmt(n, 0)}`;

/** 用户对每条建议的取舍，key 是 action.id。 */
const decisions = {};
let sampleCache = null;

async function loadSample() {
  if (sampleCache) return sampleCache;
  const res = await fetch('./data/sample.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`示例数据加载失败 HTTP ${res.status}`);
  sampleCache = await res.json();
  return sampleCache;
}

function setProgress(text) {
  $('#status').textContent = text;
}

$('#run').addEventListener('click', async () => {
  const btn = $('#run');
  btn.disabled = true;
  try {
    setProgress('加载示例数据…');
    const sample = await loadSample();

    setProgress('本地审计中（确定性计算，无网络依赖）…');
    const window = sample.meta?.window || null;
    // 让浏览器有机会把上一步的文案画出来，再进入同步计算
    await new Promise((r) => setTimeout(r, 16));
    const result = analyzeBatch(sample.records, window);
    result.carbon_profile = carbon.profileSnapshot();
    result.carbon_peak = { best_hour: carbon.bestHour(), worst_hour: carbon.worstHour() };

    // 先渲染确定性部分，AI 结论稍后填入——避免用户对着空屏等模型
    render(result);
    $('#aimode').textContent = `等待 ${DEFAULT_MODEL} 响应…`;
    $('#aitext').textContent = '模型正在自主调用工具取数，请稍候。';

    setProgress('AI 诊断中（模型正在调用工具取数）…');
    result.ai = await diagnose({
      summary: result.summary,
      findings: result.findings,
      records: result.records,
      onProgress: setProgress,
    });
    renderAi(result.ai, result);

    setProgress('完成');
  } catch (err) {
    setProgress(`失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

function render(data) {
  for (const k of Object.keys(decisions)) delete decisions[k];

  const s = data.summary;
  $('#cards').innerHTML = [
    ['浪费卡时', fmt(s.total_waste_card_hours), '卡时'],
    ['浪费电费', money(s.total_waste_cost_cny), ''],
    ['浪费电耗', fmt(s.total_waste_energy_kwh), 'kWh'],
    ['碳排当量', fmt(s.total_waste_carbon_kg), 'kgCO₂e'],
  ]
    .map(
      ([k, v, u]) =>
        `<div class="card"><div class="k">${k}</div><div class="v warn">${v}<span class="u">${u}</span></div></div>`,
    )
    .join('');

  renderCurve(data.carbon_profile, data.carbon_peak);
  renderTable(data.records);
  $('#result').style.display = 'block';
}

/** 单独渲染 AI 部分，便于「先出数字、后出结论」。 */
function renderAi(ai, data) {
  const modeNote = {
    gemini: `由 ${ai.model} 自主调用工具生成`,
    fallback: '（模型调用失败，已降级为离线规则模板）',
    offline: '（离线规则模板，未调用大模型）',
  }[ai.mode] || ai.mode;

  const degraded = ai.degraded?.length
    ? `　← 已从 ${ai.degraded.map((d) => d.model).join('、')} 降级`
    : '';
  $('#aimode').textContent = modeNote + degraded;
  $('#aitext').textContent = ai.text || '';

  // 降级原因单独一行显示：排查现场问题时，这一行往往就是全部线索
  if (ai.degraded?.length) {
    $('#degradereason').style.display = 'block';
    $('#degradereason').innerHTML =
      '换模型原因：' +
      ai.degraded
        .map((d) => `<b>${escapeHtml(d.model)}</b> — ${escapeHtml(d.reason)}`)
        .join('　｜　');
  } else {
    $('#degradereason').style.display = 'none';
  }

  const calls = ai.tool_calls || [];
  $('#toolcount').textContent = calls.length ? `共 ${calls.length} 次` : '（无工具调用）';
  $('#tools').innerHTML = calls.length
    ? calls
        .map((c) => `<li><b>${c.name}</b><span>${JSON.stringify(c.args)}</span></li>`)
        .join('')
    : '<li><span>离线模式未调用工具，结论来自规则模板。</span></li>';

  if (ai.error) {
    $('#tools').innerHTML += `<li><span>错误详情：${escapeHtml(ai.error)}</span></li>`;
  }

  renderActions(ai.actions || []);
  if (data) renderTable(data.records);
}

function renderCurve(profile, peak) {
  if (!profile) {
    $('#curve').innerHTML = '';
    return;
  }
  const hours = profile.hourly_factor;
  const max = Math.max(...hours);
  const min = Math.min(...hours);
  $('#curve').innerHTML = hours
    .map((v, h) => {
      const pct = Math.round((100 * (v - min + 0.06)) / (max - min + 0.06));
      const cls = h === peak.best_hour ? 'best' : h === peak.worst_hour ? 'worst' : '';
      return `<i class="${cls}" style="height:${Math.max(pct, 6)}%" title="${h}:00 相对强度 ${v}"></i>`;
    })
    .join('');
  $('#curveaxis').innerHTML = hours
    .map((_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`)
    .join('');
  $('#curvehint').textContent =
    `最优 ${peak.best_hour}:00 ｜ 最差 ${peak.worst_hour}:00 ｜ ${profile.note}`;
}

function renderTable(records) {
  const rows = records.slice().sort((a, b) => b.waste_cost_cny - a.waste_cost_cny);
  const head = [
    '云', '节点', '卡型', '申请', '使用', '时长(h)', '利用率(%)',
    '起始(h)', '浪费卡时', '浪费金额', '模式', '等级',
  ];
  const body = rows
    .map(
      (r) => `<tr>
    <td>${r.cloud}</td><td>${r.node}</td><td>${r.gpu_type}</td>
    <td class="num">${r.requested_cards}</td><td class="num">${r.used_cards}</td>
    <td class="num">${fmt(r.hours)}</td><td class="num">${fmt(r.avg_util_pct, 1)}</td>
    <td class="num">${r.start_hour}</td>
    <td class="num">${fmt(r.waste_card_hours)}</td><td class="num">${money(r.waste_cost_cny)}</td>
    <td>${r.pattern_label}</td>
    <td><span class="tag ${r.severity}">${r.severity}</span></td>
  </tr>`,
    )
    .join('');
  $('#tbl').innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

function renderActions(actions) {
  if (!actions.length) {
    $('#actions').innerHTML =
      '<div class="hint">本次没有登记任何建议。若为在线模式，说明模型未调用 propose_action。</div>';
    updateSummary(actions);
    return;
  }
  $('#actions').innerHTML = actions
    .map(
      (a) => `
    <div class="action" id="act-${a.id}">
      <div class="t">${a.id}｜${escapeHtml(a.title)}</div>
      <div class="d">${escapeHtml(a.detail)}</div>
      <div class="m">
        预计回收 <b>${money(a.expected_cost_recovery_cny)}</b> ｜
        预计减碳 <i>${fmt1(a.expected_carbon_reduction_kg)} kgCO₂e</i> ｜
        实施成本 ${escapeHtml(a.effort)}${a.evidence ? ` ｜ 依据：${escapeHtml(a.evidence)}` : ''}
      </div>
      <button class="mini accept" data-id="${a.id}" data-d="accept">接受</button>
      <button class="mini reject" data-id="${a.id}" data-d="reject">拒绝</button>
    </div>`,
    )
    .join('');

  $('#actions')
    .querySelectorAll('button')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        decisions[id] = btn.dataset.d;
        const box = document.getElementById(`act-${id}`);
        box.classList.toggle('done', decisions[id] === 'accept');
        box.classList.toggle('denied', decisions[id] === 'reject');
        box.querySelectorAll('button').forEach((b) => {
          b.disabled = true;
        });
        updateSummary(actions);
      });
    });
  updateSummary(actions);
}

function updateSummary(actions) {
  const accepted = actions.filter((a) => decisions[a.id] === 'accept');
  const rejected = actions.filter((a) => decisions[a.id] === 'reject');
  const cost = accepted.reduce((n, a) => n + a.expected_cost_recovery_cny, 0);
  const co2 = accepted.reduce((n, a) => n + a.expected_carbon_reduction_kg, 0);
  $('#decisionsummary').innerHTML =
    `<span>已接受 <b>${accepted.length}</b> / ${actions.length} 项</span>` +
    `<span>已拒绝 ${rejected.length} 项</span>` +
    `<span>预计可回收 <b class="warn">${money(cost)}</b></span>` +
    `<span>预计减碳 <b style="color:var(--ok)">${fmt1(co2)} kgCO₂e</b></span>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// 页面加载后预热示例数据，让首次点击更快
loadSample().catch(() => {});
