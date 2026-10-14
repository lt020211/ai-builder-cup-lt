# 部署前置条件清单

> 适用对象：本项目（Python / Flask + 自建 GitHub 仓库）
> 最后更新：**2026-10-14 第 2 版**（核实 Starter Tier 为唯一零成本路径，推翻上一版结论）

## ✅ 结论先行

先看两条**不可规避**的硬规则：

- **必须托管在 Google Cloud**。T&C 原文：*"All submitted prototypes must be built primarily using the Google
  Cloud tech stack (e.g., Cloud Run, GCP, Firebase). Solutions built primarily on competing cloud infrastructure
  will be deemed ineligible and disqualified."* 提交物必须含 *"a working deployed live URL (on Cloud Run/GCP/Firebase)"*。
- **标准 Cloud Run 强制启用结算**。官方快速入门「准备工作」原文：
  *"Verify that billing is enabled for your Google Cloud project."*

而当前账号下**不存在任何结算账号**——实测：

```
$ gcloud billing accounts list
Listed 0 items.
$ gcloud billing projects describe project-edb676e1-5c4e-4573-b16
billingEnabled: false
billingAccountName: ''
```

所以**路径 A 目前是死的**，不是配置没做对，是这个账号从来没有过结算账号。

**唯一零成本出路是 Google Cloud Starter Tier。** 官方 Gemini API 文档原文说它允许合格账号
在**不创建 GCP 项目、不绑定结算账号**的前提下发布最多 2 个全栈应用到 Cloud Run：

> **Google Cloud Starter Tier**: Lets eligible accounts publish up to 2 full-stack applications
> **without setting up a Google Cloud project or billing account**.

代价是它只接受「在 AI Studio **Build Mode** 里由 agent 生成的应用」
（官方原文明写 *"No Dockerfile, no gcloud CLI, no YAML configuration files."*），
**本仓库的 Python/Flask 代码无法直接部署**，必须在 Build Mode 中重建一套等价实现。

| 路径 | 可行性 | 成本 | 说明 |
|---|---|---|---|
| A. 标准 GCP 项目 + 结算 → Cloud Run | ❌ 当前阻塞 | — | 需要结算账号；账号下 `billing accounts` 为空表 |
| **B. Starter Tier（Build Mode 重建）** | ✅ **唯一零成本路径** | ¥0 | 免绑卡；需把逻辑移植为 React + Node |
| C. Firebase Hosting Spark（纯静态） | ⚠️ 次选 | ¥0 | 免绑卡，但服务端 Python 跑不了，需全量前端化 + 用户自带 Key |
| D. Google Apps Script | ❌ 不建议 | ¥0 | 免费且 Google 托管，但**不在 T&C 明列的 Cloud Run/GCP/Firebase 之内**，合规风险高 |

### Starter Tier 的两个资格陷阱（务必先验证）

1. **曾经拥有过付费 Cloud Billing 账号即永久失去资格**——本账号从未有过，**不构成排除**。
2. 官方明确 *"We don't have enough evidence from your account activity to grant Starter Tier access at this time"*——
   **全新账号可能被判不合格，且支持团队无法覆盖该判断。**

→ 所以第一步必须做**零成本探针**：打开 AI Studio Build Mode，随便生成一个小应用，
点 **Publish**，看是否出现 Starter Tier 发布入口。出现 = 资格通过，整条路径打通。

## 路径 A：标准 Google Cloud 项目（❌ 当前不可行：无结算账号）

### A1. 账号与项目

- [ ] 一个 Google 账号（个人 Gmail 最省事；Workspace 账号可能被组织策略限制）
- [ ] 一个 GCP 项目，记下 **Project ID**（形如 `my-project-123456`）
- [ ] 该项目已启用 **Cloud Billing**（绑定付款方式）

```bash
gcloud config set project <PROJECT_ID>
```

### A2. 需要启用的 API

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

### A3. IAM 权限

最低所需角色（项目 Owner 已包含全部）：

| 角色 | 用途 |
|---|---|
| Cloud Run Admin | 部署与更新服务 |
| Service Account User | 让 Cloud Run 以服务账号身份运行 |
| Artifact Registry Writer | 推送镜像 |
| Cloud Build Editor | 云端构建镜像（使用 Cloud Build 时） |
| Secret Manager Secret Accessor | 运行时读取 API Key |

### A4. 构建产物

- [x] `Dockerfile`（仓库已有）
- [ ] 一个 Artifact Registry Docker 仓库

```bash
gcloud artifacts repositories create gpu-waste-auditor \
  --repository-format=docker --location=asia-east1
```

### A5. AI 凭证（二选一）

- [ ] **方案一（简单）**：Google AI Studio 生成 Gemini API Key → 存入 Secret Manager
- [ ] **方案二（进阶）**：改用 Vertex AI（需启用 `aiplatform.googleapis.com` 并授予服务账号相应角色）

### A6. 区域选择

| 区域 | 位置 | 价格档 |
|---|---|---|
| **`asia-east1`** | 中国台湾 | **Tier 1（较低）** ← 建议 |
| `asia-southeast1` | 新加坡 | Tier 2（较高） |

免费额度按 `us-central1` 价格基准计算，但所选区域的单价按上表分层。

## 路径 B：Starter Tier —— ✅ 唯一零成本路径（需在 Build Mode 重建）

**这是当前唯一能在 10-18 截止前走通的部署路径。** 详见文首结论。

流程（官方文档「From prompt to live URL in five steps」）：

1. 打开 AI Studio，切到 **Build Mode**（*"No payment method, no project setup."*）
2. 用提示词描述应用 —— agent 生成 **React 前端 + Node.js 后端**
3. 若提示需要 Firebase，按需启用（会锁定 Cloud Run 区域）
4. 点 **Publish → Get Started → Publish App**，agent 打包代码并在 Starter Tier 项目里开通 Cloud Run 服务
5. 拿到 `.run.app` 公网 URL

### 为什么 API Key 不是问题

Build Mode 会**自动**把 Gemini Key 以**服务端密钥**注入，客户端拿不到：

> "AI Studio automatically configures your Gemini API key as a secret in the app's server-side environment."
> "**Server-side only**: API keys are injected into the server-side runtime and are never included in client-side code."
> "**Cloud Run**: When you deploy to Cloud Run from AI Studio, your API key is included securely in the server-side environment."

顺带解决一个大问题：调用从 **Google 机房出口**发起，天然绕开本机的地域限制
（`FAILED_PRECONDITION: User location is not supported`），演示视频可以录到真实工具调用轨迹。

### 已知限制

每账号最多 **2 个应用**、**单一区域锁定**（不可改）、
API 面锁死（禁用 BigQuery / Pub/Sub / Cloud Functions）、**临时文件系统**（写盘内容随缩容/重部署消失）、
适用独立的 Starter Tier 附加条款。另：区域在首个资源创建时锁定，**选错无法更改**。

### 与 GitHub 仓库的一致性

T&C 要求公开仓库与部署产物一致。Build Mode 支持把生成的应用**导出为 ZIP**，
因此正确做法是：部署上线后把导出 ZIP 作为仓库源码，避免「线上是 A、仓库是 B」的错配。

## 路径 C：Firebase —— ❌ 对本项目无免绑卡优势

| 组件 | Spark（免费 · 不绑卡） | Blaze（按量 · 需绑卡） |
|---|---|---|
| Hosting 静态托管 | ✅ 10 GB 存储 / 360 MB 天 | ✅ 同额度 + 超额计费 |
| Cloud Functions | ❌ 不可用 | ✅ 200 万次调用 / 月免费 |
| **本项目可用性** | ❌ 服务端 Python **跑不了** | ✅ 可用，但等于回到绑卡路径 |

**结论**：本项目是 Python 服务端应用，Firebase Hosting 免费版只能托管静态文件，跑不了。
要走 Firebase 就必须升级 Blaze 并绑卡——**没有绕开绑卡的优势**。

> 附注（一个已被排除的替代方案）：理论上可以把整套计算逻辑改写为浏览器端 JS、
> 连同「用户自带 Gemini Key」的调用方式一起做成纯静态站点，托管在 Firebase Hosting Spark 上，
> 从而完全绕开绑卡。但代价是要丢弃已测试的 Python 代码库、重写全部逻辑，
> 且在 5 天窗口内引入大量新风险。**不推荐，仅作为兜底记录。**

## 成本预期

### Gemini API：免费层即可，**不需要绑卡**

2026-10-14 实测（项目 `project-edb676e1-5c4e-4573-b16`，未绑任何结算账号）：

| 项目 | 实测值 |
|---|---|
| 配额指标 | `generativelanguage.googleapis.com/generate_content_free_tier_requests` |
| 限额 | **5 请求 / 分钟 / 项目 / 模型** |
| 是否需要结算 | **不需要**，`FreeTier` 配额正常放行 |
| 可用模型 | `gemini-3.8-flash`（`gemini-2.5-flash` 已对新用户下线，返回 404） |

→ 如果只是为了调模型，**完全不需要绑卡**。绑卡的唯一原因是把服务托管到 Cloud Run。

### Cloud Run

Cloud Run 免费额度（按请求计费型，按结算账号汇总、每月重置）：

| 项目 | 每月免费额度 |
|---|---|
| 请求数 | 200 万次 |
| CPU | 18 万 vCPU-秒 |
| 内存 | 36 万 GiB-秒 |

本 demo（偶尔被访问、每次几百毫秒、1 vCPU / 512 MiB）**预期花费 $0**。

前提：`minScale: 0`（`deploy/service.yaml` 已设置）——空闲时缩容到零实例，不产生实例费用。**如果把 minScale 调成 1 保活，就会产生 7×24 常驻费用。**

⚠️ Cloud Run 定价**不含** Cloud Build 与 Artifact Registry 的费用，两者各有独立免费额度。

## 尚未确认的点（部署前请实测）

1. **本账号是否符合 Starter Tier 资格**：排除项已核对（非 Workspace 账号、无历史结算账号），
   但官方保留「账号活跃度证据不足」这一条主观判断。**这是当前唯一的外部阻塞点**，
   只能由账号持有人在浏览器里实测（做探针，见下）。
2. **Starter Tier 锁定区域的时机与可选值**：区域在首个资源创建时锁定且**不可更改**，
   探针阶段就应选好（建议 `asia-east1` 中国台湾，Tier 1 单价较低）。

## 最短可行路径

**第一步永远是那个零成本探针**——它决定后面走哪条路：

| # | 步骤 | 谁来做 | 预计耗时 | 位置 |
|---|---|---|---|---|
| **0** | **探针：Build Mode 生成小应用 → 点 Publish，看是否有 Starter Tier 入口** | 你（浏览器交互） | 3 分钟 | <https://aistudio.google.com> |
| 1 | 有入口 → 在 Build Mode 按规格重建应用并发布，拿 `.run.app` URL | 你 + agent | 数小时 | Build Mode |
| 2 | 导出 ZIP，作为公开 GitHub 仓库源码 | 你 | 5 分钟 | Build Mode → 下载 |
| 3 | 对着线上 URL 录 < 3 分钟演示视频 | 你 | 1 小时 | 见 `docs/demo-script.md` |
| 4 | deck 导出 PDF 提交 | 你 | 1 小时 | — |

**没有入口（资格被拒）时的退路**：只能回到路径 A——找一张可用的国际信用卡开通结算，
再执行下面这条已脚本化的一键部署命令。

```bash
# 路径 A 备用：绑定结算后
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
gcloud auth login
printf '%s' '你的Gemini密钥' | gcloud secrets create gemini-api-key \
  --data-file=- --replication-policy=automatic        # 需先设好默认项目
./deploy/deploy.sh <PROJECT_ID>
```

`deploy/deploy.sh` 是幂等的：前置检查（登录 / 项目 / 结算）→ 启用 API →
确保 Artifact Registry 仓库 → 挂载密钥 → 云端构建部署 → 部署后自动 curl 验证。
**不需要本地 Docker**（走 Cloud Build 构建）。

> 若先跳过密钥直接部署，页面仍可运行，但「AI 工具调用轨迹」会显示"离线模式未调用工具"——
> 这会丢掉本项目最主要的差异化展示。**建议先配密钥再部署**，或配好后重跑脚本覆盖。
