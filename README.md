# GPU 算力浪费审计器

> Google Cloud AI Builder Cup 2026（JAPAC）参赛项目
> 参赛者：lt020211 ｜ 作品名：AI Builder Cup-lt

## 一句话方案

**把多云 GPU 集群「预留了卡却没在用」的隐性浪费，算成电费与碳排，再由 Gemini 解释根因并给出可排期的优化动作。**

## 赛题对齐

| 项目 | 内容 |
|---|---|
| 赛题 / 方向 | 可持续性和社会影响 |
| 目标用户 | 多云 GPU 集群的运维与平台团队、算力预算负责人 |
| 核心痛点 | 传统监控只报「利用率是多少」，不报「这些浪费值多少钱、该先动哪个、动了能省多少」 |
| 我们的解法 | 确定性计算层算出浪费卡时/电费/电耗/碳排 → AI 层做根因解释与优化动作排序 |
| 为什么必须用 AI | 浪费模式识别与根因推断依赖跨节点、跨卡型的上下文理解；把审计结果翻译成可排期的动作需要自然语言解释能力，规则引擎只能给出数字，给不出「为什么」和「先做哪个」 |

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
                                     ai.py（Gemini 诊断）
                                          ↓
                                  Flask Web（Cloud Run）
```

**设计取舍**：所有数字由确定性代码算出，AI 只做解释与建议。好处是数字可复算、可审计，不会出现「AI 编了个数」；同时没有密钥也能演示。

**核心口径**（完整假设见 [docs/architecture.md](docs/architecture.md)）：

```
浪费卡时 = max(申请卡数 − 使用卡数, 0) × 时长
         + 使用卡数 × 时长 × (1 − 平均利用率)      [仅当利用率 < 30%]
浪费电耗 = 浪费卡时 × 单卡 TDP × 0.25
浪费电费 = 浪费电耗 × ¥0.70/kWh
浪费碳排 = 浪费电耗 × 0.581 kgCO₂e/kWh
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | Web 界面 |
| GET | `/healthz` | 健康检查，返回 `{"status":"ok"}` |
| GET | `/api/sample` | 返回脱敏示例数据 |
| POST | `/api/analyze` | 传入 `{"records":[...], "window":"..."}` 做审计；不传 records 则使用示例数据 |

请求示例：

```bash
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
```

## 目录结构

```
.
├── README.md
├── LICENSE
├── Dockerfile                    Cloud Run 构建入口
├── requirements.txt
├── .env.example                  环境变量模板（.env 不提交）
├── src/
│   ├── app.py                    Flask 入口与 API
│   ├── analyzer.py               浪费识别与折算（纯计算，可单测）
│   ├── ai.py                     Gemini 调用与离线降级
│   ├── prompts/diagnose.md       诊断提示词模板
│   └── templates/index.html      Web 界面
├── data/sample_metrics.json      脱敏示例数据
├── tests/test_analyzer.py        单元测试
├── scripts/run_local.sh          本地一键启动
├── deploy/service.yaml           Cloud Run 服务定义
└── docs/
    ├── architecture.md           架构与完整计算口径
    └── demo-script.md            3 分钟演示视频分镜
```

## 提交物清单

- [x] **公开** GitHub 仓库（本仓库）
- [ ] 可访问的已部署原型链接（Cloud Run）
- [ ] 演示视频（**少于 3 分钟**）— 分镜见 [docs/demo-script.md](docs/demo-script.md)
- [ ] 方案说明 deck
- [x] 代码为赛期内新做

## 已知限制与不确定项

1. **能耗是近似值**：用 `TDP × 0.25` 估算空转功耗，非实测。接入 DCGM/IPMI 功耗读数后可替换为实测曲线。
2. **利用率按周期平均**，会掩盖「前 80% 满载、后 20% 空转」的分布问题。
3. **未做任务级归因**：知道哪个节点浪费，不知道是哪个任务造成。
4. **电价与碳排因子为常量**，未按地域与时段区分；真实账单是阶梯电价，不同区域电网碳排因子差异明显。
5. 卡时单价为估算值，需按实际采购/租赁台账校准。

以上限制在技术评审环节会被问到，本文档直接列为已知边界而非回避。

## 许可

[MIT](LICENSE)
