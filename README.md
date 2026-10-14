# GPU 算力浪费审计器

> Google Cloud AI Builder Cup 2026（JAPAC）参赛项目
> 参赛者：lt020211 ｜ 作品名：AI Builder Cup-lt

**语言：** [🇬🇧 English](README.en.md) ｜ 🇨🇳 中文

## 一句话方案

**把多云 GPU 集群「预留了卡却没在用」的隐性浪费，算成电费与碳排，再让 Gemini 自主调用工具取数、给出可排期可决策的优化动作——并回答「什么时候跑最省碳」。**

> 从「事后审计报告」升级为「碳感知调度决策器」：AI 不再只解释数字，而是**先调工具拿数据、再下结论**，
> 且每条建议都能在前端被**接受或拒绝**，交互终点是决策而不是阅读。

## 赛题对齐

| 项目 | 内容 |
|---|---|
| 赛题 / 方向 | 可持续性和社会影响 |
| 目标用户 | 多云 GPU 集群的运维与平台团队、算力预算负责人 |
| 核心痛点 | 传统监控只报「利用率是多少」，不报「这些浪费值多少钱、该先动哪个、动了能省多少」 |
| 我们的解法 | 确定性计算层算出浪费卡时/电费/电耗/碳排 → AI 通过 function calling 自主取数，产出根因解释与可决策的优化动作 |
| 为什么必须用 AI | 浪费模式识别与根因推断依赖跨节点、跨卡型的上下文理解；把审计结果翻译成可排期的动作需要自然语言解释能力。规则引擎能给数字，给不出「为什么」和「先做哪个」 |

### 两个差异化设计

**1. AI 是工具调用者，不是文本生成器。** 模型必须先调 `query_metrics` 取数、调 `simulate_defer` 算碳，才能下结论。
数字全部来自确定性代码，模型无法凭空生成——这直接对应评审项里 40% 的「技术质量与生成式 AI 实现」。

**2. 引入电网碳强度时段曲线（碳感知调度）。** 同样一度电，正午光伏出力高峰时碳强度最低（0.82×），
晚高峰火电调峰时最高（1.10×）。这意味着**电耗不变、电费不变，只把负载挪个时段，碳排就能降约 25%**。
这是「可持续性」赛道里少见的、有物理依据且可量化的优化维度。

## 快速开始（本地）

```bash
# 一键：建虚拟环境 → 装依赖 → 跑测试 → 起服务
chmod +x scripts/run_local.sh && ./scripts/run_local.sh
```

然后打开 <http://127.0.0.1:8080>，点击「加载示例数据并分析」。

也可以手动分步：

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m unittest discover -s tests -v      # 跑测试
python -m src.app                            # 起服务
```

**不配置任何密钥也能完整演示**：AI 诊断会自动降级为离线规则模板。要启用真正的模型诊断：

```bash
cp .env.example .env      # 填入 GEMINI_API_KEY
export GEMINI_API_KEY="你的密钥"
```

## 部署到 Cloud Run

> 部署前置条件（账号、需启用的 API、IAM 角色、区域选择、成本预期）逐项清单见 **[deploy/PREREQUISITES.md](deploy/PREREQUISITES.md)**。

```bash
PROJECT_ID=你的项目ID
REGION=asia-east1
REPO=gpu-waste-auditor

# 1. 构建并推送镜像
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/gpu-waste-auditor:latest

# 2. 把 API Key 存进 Secret Manager
echo -n "你的Gemini密钥" | gcloud secrets create gemini-api-key --data-file=-

# 3. 部署
#    先替换 deploy/service.yaml 里的 PROJECT_ID 与 REPO 占位符
gcloud run services replace deploy/service.yaml --region=$REGION
```

## 工作原理

```
监控数据 → analyzer.py（确定性计算）→ 结构化审计结果
                                          ↓
                                  ai.py（Gemini 工具调用循环）
                                    ↕  query_metrics / estimate_carbon
                                    ↕  simulate_defer / propose_action
                                          ↓
                             Flask Web（Cloud Run）→ 指标卡 + 碳曲线 + 工具轨迹 + 决策清单
```

**设计取舍**：所有数字由确定性代码算出，AI 只做「取数—推理—登记建议」。好处是数字可复算、可审计，
不会出现「AI 编了个数」；同时没有密钥也能降级演示。

**AI 工具调用循环**（`ai.py::_agentic_diagnose`）：

```
模型 → 返回 functionCall → 本地执行工具 → 把结果回灌 → 模型 → … → 最终文本
```

最多 8 轮（`MAX_TOOL_TURNS`），一旦模型产出文本即结束。四个工具：

| 工具 | 作用 |
|---|---|
| `query_metrics` | 按云 / 模式 / 金额排序取明细，模型拿到的数字只能来自这里 |
| `estimate_carbon` | 给定电耗与时段，返回碳排与当日最优时段 |
| `simulate_defer` | 把某节点负载从当前时段挪到低碳时段，测算减碳量与比例 |
| `propose_action` | 登记一条可执行建议，前端据此渲染「接受 / 拒绝」 |

**核心口径**（完整假设见 [docs/architecture.md](docs/architecture.md)）：

```
浪费卡时 = max(申请卡数 − 使用卡数, 0) × 时长
         + 使用卡数 × 时长 × (1 − 平均利用率)      [仅当利用率 < 30%]
浪费电耗 = 浪费卡时 × 单卡 TDP × 0.25
浪费电费 = 浪费电耗 × ¥0.70/kWh
浪费碳排 = 浪费电耗 × 0.581 kgCO₂e/kWh × 时段系数 × 区域系数
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | Web 界面 |
| GET | `/healthz` | 健康检查，返回 `{"status":"ok"}` |
| GET | `/api/sample` | 返回脱敏示例数据 |
| GET | `/api/carbon-profile` | 全天电网碳强度曲线（24 点相对系数）与最优/最差时段 |
| POST | `/api/analyze` | 传入 `{"records":[...], "window":"..."}` 做审计；不传 records 则使用示例数据。返回汇总、明细、碳曲线与 AI 决策 |

`/api/analyze` 返回结构中与 AI 相关的字段：

```json
{
  "ai": {
    "mode": "gemini | offline | fallback",
    "model": "gemini-2.5-flash",
    "text": "模型生成的诊断文本",
    "tool_calls": [{"name": "query_metrics", "args": {...}}],
    "actions": [{
      "id": "A1",
      "title": "空转节点自动回收",
      "expected_cost_recovery_cny": 68307.0,
      "expected_carbon_reduction_kg": 266.9,
      "effort": "中"
    }]
  },
  "carbon_profile": {"hourly_factor": [24 个相对系数], "best_hour": 13, "worst_hour": 19},
  "carbon_peak": {"best_hour": 13, "worst_hour": 19}
}
```

请求示例：

```bash
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
```

## 目录结构

```
.
├── README.md                     中文版说明（本文件）
├── README.en.md                  English README
├── LICENSE
├── Dockerfile                    Cloud Run 构建入口
├── requirements.txt
├── .env.example                  环境变量模板（.env 不提交）
├── src/
│   ├── app.py                    Flask 入口与 API
│   ├── analyzer.py               浪费识别与折算（纯计算，可单测）
│   ├── carbon.py                 电网碳强度时段模型（碳感知调度依据）
│   ├── tools.py                  AI 可调用的四个工具 + 工具会话状态
│   ├── ai.py                     Gemini 工具调用循环与离线降级
│   ├── prompts/diagnose.md       诊断提示词模板
│   └── templates/index.html      Web 界面（指标卡 / 碳曲线 / 工具轨迹 / 决策清单）
├── data/sample_metrics.json      脱敏示例数据
├── tests/
│   ├── test_analyzer.py          计算层测试
│   ├── test_carbon.py            碳强度模型测试
│   ├── test_tools.py             工具与分发测试
│   └── test_ai.py                AI 层与离线降级测试
├── scripts/run_local.sh          本地一键启动
├── deploy/
│   ├── PREREQUISITES.md          部署前置条件清单
│   └── service.yaml              Cloud Run 服务定义
└── docs/
    ├── architecture.md           架构与完整计算口径
    ├── architecture.en.md        Architecture and calculation basis (English)
    ├── demo-script.md            3 分钟演示视频分镜
    └── demo-script.en.md         Demo video storyboard (English)
```

## 提交物清单

- [x] **公开** GitHub 仓库（本仓库）
- [ ] 可访问的已部署原型链接（Cloud Run）
- [ ] 演示视频（**少于 3 分钟**）— 分镜见 [docs/demo-script.md](docs/demo-script.md)
- [ ] 方案说明 deck
- [x] 代码为赛期内新做
- [x] 英文版文档（[README.en.md](README.en.md)、[architecture.en.md](docs/architecture.en.md)、[demo-script.en.md](docs/demo-script.en.md)）——面向 JAPAC 国际评审

## 已知限制与不确定项

1. **能耗是近似值**：用 `TDP × 0.25` 估算空转功耗，非实测。接入 DCGM/IPMI 功耗读数后可替换为实测曲线。
2. **利用率按周期平均**，会掩盖「前 80% 满载、后 20% 空转」的分布问题。
3. **未做任务级归因**：知道哪个节点浪费，不知道是哪个任务造成。
4. **电价仍为常量**：真实账单是阶梯电价。碳排已按**时段**区分（24 点相对曲线），并支持**区域**系数；
   但时段曲线与区域系数是公开资料的**简化近似，不是实测数据**，接入 Electricity Maps 等真实碳强度源后方可作调度依据。
5. **碳感知调度假设负载可平移**：对训练任务而言，只有具备 checkpoint 续训能力的任务才真正可延后；
   本项目把「可延后性」作为待补数据列出，没有擅自假设所有任务都能挪时段。
6. 卡时单价为估算值，需按实际采购/租赁台账校准。

以上限制在技术评审环节会被问到，本文档直接列为已知边界而非回避。

## 许可

[MIT](LICENSE)
