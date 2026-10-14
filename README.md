# GPU 算力浪费审计器

> Google Cloud AI Builder Cup 2026（JAPAC）参赛项目
> 参赛者：lt020211 ｜ 作品名：AI Builder Cup-lt

**语言：** [🇬🇧 English](README.en.md) ｜ 🇨🇳 中文

## 🟢 线上演示（已部署，可直接点开）

**<https://gpu-waste-auditor-2026.web.app>** ｜ 备用域名 <https://gpu-waste-auditor-2026.firebaseapp.com>

点「加载示例数据并分析」即可。这是**纯静态站点**：没有后端服务，审计计算在浏览器内完成，
Gemini 通过 **Firebase AI Logic** 直连调用（模型自主决定调用哪些工具）。

实测一次完整分析约 **9 秒**，模型自主发起 **11 次工具调用**，无任何后端参与。
即使模型不可用，页面也会自动降级为离线规则模板，功能完整可演示。

> 免费层配额有限（每个模型 20 次/天），所以实现了模型降级链——
> 首选 `gemini-3.5-flash-lite`（单回合约 1.5s），配额用尽后依次切到备用模型，
> 界面会如实显示「为什么换了模型」。

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

## 部署到 Firebase（线上演示用的就是这条路径）

这套代码有**两份等价实现**，选择哪份取决于部署形态：

| | 浏览器端 JS（线上） | Python / Flask（本地与 Cloud Run） |
|---|---|---|
| 位置 | `firebase/public/` | `src/` |
| 计算 | 浏览器内 | 服务端 |
| Gemini 调用 | Firebase AI Logic 直连 | 服务端 HTTP |
| 部署 | Firebase Hosting（**免结算账号、免绑卡**） | Cloud Run（需结算账号） |
| 用途 | 线上可点开的演示 | 参考实现、单元测试、可复算 |

两份实现**算法与常量为逐行一致**，并用差分测试守住：同一份输入分别跑两份实现、逐字段比对。
详见下方「移植保真度」一节。

```bash
# 发布（纯 REST，不需要 firebase CLI，也不需要交互式登录）
python3 scripts/fb_deploy.py firebase/public
```

> 为什么不用 `firebase deploy`：本机没装 CLI，且 CLI 需要一次交互式 OAuth；
> 而 gcloud 已登录，直接用它的 access token 打 Hosting REST 接口更省事。
> 脚本内联注释记录了三个踩过的坑（gzip 后取哈希、不能带 `Content-Encoding`、
> 固定 `mtime=0` 保证压缩结果可复现）。

### 移植保真度

不是靠人工核对，而是**差分测试**：

```bash
python3 scripts/diff_port.py            # 逐字段比对 Python 与 JS 的输出
```

覆盖 `analyze_batch` 全量输出、17 次工具调用（含越界、类型错误、未知工具等边界用例）、
离线诊断文本。任一字段不一致都会打印出具体路径。

## 部署到 Cloud Run（备选）

> ⚠️ **两条部署路径，按账号情况二选一。**
>
> - **路径 A（标准项目 + 结算）**——最直接：建一个 GCP 项目、启用结算，然后一条命令部署。
>   前提是账号已能绑定结算账号。
> - **路径 B（Cloud Starter Tier）**——**免绑卡、免建项目**的零成本路径。官方原文：
>   *"Lets eligible accounts publish up to 2 full-stack applications without setting up a Google Cloud
>   project or billing account."* 代价是它只接受在 AI Studio **Build 模式**里由 agent 生成的应用
>   （React + Node），**不能直接部署本仓库的 Python / Flask 代码**。
>
> 两条路的完整依据、Starter Tier 的资格条件、区域锁定规则与最短可行步骤，
> 见 **[deploy/PREREQUISITES.md](deploy/PREREQUISITES.md)**。

### 路径 A：一条命令

```bash
gcloud auth login                      # 浏览器交互
./deploy/deploy.sh <PROJECT_ID>        # 幂等：检查 → 启用 API → 建仓库 → 部署 → 验证
```

脚本会依次做前置检查（登录 / 项目 / 结算）、启用所需 API、确保 Artifact Registry 仓库存在、
挂载 Gemini 密钥、在云端构建并部署、最后自动 curl 验证。**不需要本地 Docker**。

> 未配置密钥也能部署，但页面上的「AI 工具调用轨迹」会显示"离线模式未调用工具"——
> 这会丢掉本项目最主要的差异化展示。建议先配密钥（见 `deploy/PREREQUISITES.md` 第 3 步）。

### 路径 A'：手动分步

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

线上形态（纯静态，无后端）：

```
监控数据 → analyzer.js（确定性计算）→ 结构化审计结果
                                        ↓
                                ai.js（Gemini 工具调用循环）
                                  ↕  query_metrics / estimate_carbon
                                  ↕  simulate_defer / propose_action
                                  ↑  Firebase AI Logic（浏览器直连）
                                        ↓
                Firebase Hosting → 指标卡 + 碳曲线 + 工具轨迹 + 决策清单
```

本地 / Cloud Run 形态（Python 参考实现）与此一一对应，只是把上图的 `.js` 换成 `.py`、
把「浏览器直连 AI Logic」换成「Flask 服务端调用 Gemini」，输出完全一致（由差分测试保证）。

**设计取舍**：所有数字由确定性代码算出，AI 只做「取数—推理—登记建议」。好处是数字可复算、可审计，
不会出现「AI 编了个数」；同时模型不可用时也能降级演示。

**AI 工具调用循环**（`ai.py::_agentic_diagnose` / `ai.js::agenticDiagnose`）：

```
模型 → 返回 functionCall → 本地执行工具 → 把结果回灌 → 模型 → … → 最终文本
```

最多 6 轮（`MAX_TOOL_TURNS`），一旦模型产出文本即结束。四个工具：

| 工具 | 作用 |
|---|---|
| `query_metrics` | 按云 / 模式 / 金额排序取明细，模型拿到的数字只能来自这里 |
| `estimate_carbon` | 给定电耗与时段，返回碳排与当日最优时段 |
| `simulate_defer` | 把某节点负载从当前时段挪到低碳时段，测算减碳量与比例 |
| `propose_action` | 登记一条可执行建议，前端据此渲染「接受 / 拒绝」 |

### 浏览器端实现的两个坑（都写进了代码注释）

**1. AI Logic 的官方 JS SDK 用不了。** SDK 的 `ChatSession` 把工具结果回传的角色写死为
`role: "function"`，而新版模型已不接受这个角色：

```
400 Role 'function' is not supported. Please use a valid role:
    SYSTEM, USER, ASSISTANT, DEVELOPER, CONTEXT, ... MODEL
```

改用 `role: "user"` 回传本来是对的，却又被 SDK 的客户端校验拦住
（`Content with role 'user' can't contain 'functionResponse' part`）。
两条路都堵死 —— 所以 `ai.js` 直接打 REST，自己控制 `contents` 的角色。
顺带去掉了 150KB 的 SDK 依赖。

**2. 鉴权只能用 header `x-goog-api-key`。** 用查询参数 `?key=` 会被边缘直接返回
HTML 400，看起来像「模型不存在」，极易误判成模型下线。已被这个假象误导过一次。

**模型降级链**：免费层每个模型的日配额独立且有限，所以按
`gemini-3.5-flash-lite → gemini-3.5-flash → gemini-3.1-flash-lite → gemini-3.8-flash`
依次尝试。区分两种 429：短时限流就等一下重试同一个模型；当日配额耗尽（响应里会写
`retry in 18h44m`）则立刻换模型——否则界面会挂十几个小时。换模型的原因会如实显示在界面上。

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
    "model": "gemini-3.8-flash",
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
├── firebase/public/              ★ 线上部署的纯静态站点
│   ├── index.html                页面骨架（指标卡 / 碳曲线 / 工具轨迹 / 决策清单）
│   ├── styles.css
│   ├── js/analyzer.js            浪费识别与折算
│   ├── js/carbon.js              电网碳强度时段模型
│   ├── js/tools.js               四个工具 + 分发
│   ├── js/ai.js                  AI Logic 工具调用循环与离线降级
│   ├── js/prompt.js              诊断提示词模板
│   ├── js/app.js                 界面装配
│   └── data/sample.json          浏览器侧读取的示例数据
├── scripts/run_local.sh          本地一键启动
├── scripts/fb_deploy.py          发布静态站点到 Firebase Hosting（纯 REST）
├── scripts/diff_port.py          差分测试：Python 参考实现 vs JS 移植版
├── scripts/probe_*.py            摸清 AI Logic 行为的一次性探针脚本
├── deploy/
│   ├── deploy.sh                 部署到 Cloud Run 的一键幂等脚本
│   ├── PREREQUISITES.md          部署前置条件清单
│   └── service.yaml              Cloud Run 服务定义（声明式替代方案）
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
7. **免费层配额是演示期最硬的约束**（2026-10-14 实测，非估算）：
   - 每个模型有**独立的日配额**，且很小 —— `gemini-3.8-flash` 实测为 **20 次/天/项目**，
     耗尽后返回 `429 ... retry in 18h44m`（按太平洋时间零点重置）。此外还有每分钟请求数限制。
   - 因此实现了**模型降级链**：`gemini-3.5-flash-lite → gemini-3.5-flash → gemini-3.1-flash-lite
     → gemini-3.8-flash`。代码区分两种 429 —— 短时限流就等一下重试同一个模型；
     当日配额耗尽则**立刻换模型**（否则界面会挂十几个小时）。换模型的原因会如实显示在界面上。
   - 实测一次完整分析（11 次工具调用）约 9 秒；单个模型当日约可支撑 40+ 次演示。
8. **前端持有 Firebase Web API Key（这是 Firebase 的既有设计，非疏漏）**：
   该 Key 本就公开出现在任何 Firebase 网页的源码里，真正的保护是安全规则与 App Check。
   当前 **App Check 尚未强制**（Firebase 计划 2026-11-02 起对 AI Logic 强制），
   也就是说现阶段他人在理论上可以复用该配额。届时通过请求头附加 App Check token 即可闭合，
   业务逻辑无需改动。这是已识别、有明确收敛动作的边界。
9. **AI Logic 的官方 JS SDK 未被采用**，原因是它在工具调用的多回合场景下有硬缺陷
   （角色写死为 `function`，且客户端校验阻止改用 `user`）。详见「工作原理」一节。
   代价是需自行处理鉴权与超时，收益是能与 Python 参考实现保持 1:1 并去掉 150KB 依赖。

以上限制在技术评审环节会被问到，本文档直接列为已知边界而非回避。

## 许可

[MIT](LICENSE)
