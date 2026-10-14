# 部署前置条件清单

> 适用对象：本项目（Python / Flask + 自建 GitHub 仓库）
> 最后更新：**2026-10-14**（本版根据官方文档核实，纠正了上一版对 Starter Tier 的判断）

## ✅ 结论先行：本项目**必须**使用标准项目 + 启用结算（Billing）

上一版把「Starter Tier 零账单」列为可用路径 B，并标注「未确认能否部署自带 Dockerfile」。
**现已用一手文档核实，答案是：不能。因此 Starter Tier 对本项目不可用。**

| 此前的疑问 | 核实结论 | 依据 |
|---|---|---|
| Starter Tier 能否部署自带 Dockerfile / 已有仓库？ | **不能** | 官方：Starter Tier 的发布流程是「Open Google AI Studio **Build Mode** → 用提示词描述应用 → agent 生成 React 前端 + Node 后端 → 点 Publish」。官方原文明写 *"No Dockerfile, no gcloud CLI, no YAML configuration files."* |
| 标准项目下 Cloud Run 是否强制要求启用结算？ | **强制要求** | Cloud Run 官方 Python 快速入门「准备工作」原文：*"Verify that billing is enabled for your Google Cloud project."* |

**推论**：本项目是 Python / Flask 服务端应用，仓库里有自己的 `Dockerfile` 与测试。
走 Starter Tier 就必须放弃这个仓库、改由 AI Studio 的 agent 重新生成一套 React + Node 代码——
那等于把已完成的 54 项测试、碳强度模型与工具调用循环全部作废。**因此路径 A 是唯一可行路径。**

> Starter Tier 的额外资格陷阱（供参考，本项目已不适用）：一旦账号曾经拥有过付费 Cloud Billing 账号即**永久**失去资格；
> 且官方明确 *"We don't have enough evidence from your account activity to grant Starter Tier access at this time"*——
> 全新账号也可能不符合条件，且支持团队无法覆盖该判断。

## 路径 A：标准 Google Cloud 项目（**唯一可行路径**）

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

## 路径 B：Starter Tier —— ❌ 对本项目不可用

**已核实：不可用，不必尝试。** 详见文首的结论表。

Starter Tier 的定位是「在 AI Studio Build 模式里从提示词生成应用并直接发布」，
它不提供「部署任意容器镜像」的能力。本项目有自己的 `Dockerfile`、`requirements.txt`、
测试套件与 GitHub 仓库，与之不兼容。

已知限制（供理解，本项目不适用）：每账号最多 **2 个应用**、**单一区域锁定**、
API 面锁死（禁用 BigQuery / Pub/Sub / Cloud Functions）、临时文件系统、适用独立的 Starter Tier 附加条款。

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

1. **能否用中国内地签发的双币/国际信用卡完成 Google Cloud 开通**：
   Google 支持银联部分卡种与主流国际卡组织，但风控拒绝并不罕见。**这是当前唯一的外部阻塞点**，
   本次无法在本地验证，必须由账号持有人实测。
2. **项目所在区域是否受组织策略限制**：若使用 Google Workspace 账号，组织策略可能禁止
   公开（`allUsers`）访问。个人 Gmail 账号无此问题。

## 最短可行路径

前置条件只有两项需要账号持有人操作，其余全部已脚本化：

| # | 步骤 | 谁来做 | 预计耗时 | 位置 |
|---|---|---|---|---|
| 1 | 用 Google 账号登录并授权 CLI | 你（浏览器交互） | 2 分钟 | `gcloud auth login` |
| 2 | 创建/选择项目，**开通结算（绑卡）** | 你（浏览器交互） | 5–10 分钟 | <https://console.cloud.google.com/billing> |
| 3 | 拿到 Gemini API Key | 你 | 2 分钟 | <https://aistudio.google.com/apikey> |
| 4 | 存密钥、启用 API、构建、部署、验证 | **一条命令** | 约 5 分钟 | `./deploy/deploy.sh <PROJECT_ID>` |

第 4 步的脚本 `deploy/deploy.sh` 是幂等的：前置检查（登录 / 项目 / 结算）→ 启用 API →
确保 Artifact Registry 仓库 → 挂载密钥 → 云端构建部署 → 部署后自动 curl 验证。
**不需要本地 Docker**（走 Cloud Build 构建）。任一步失败都会给出明确的下一步提示。

```bash
# 1) 登录（会打开浏览器）
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
gcloud auth login

# 2) 开通结算后，记下 Project ID，然后：
cd ai-builder-cup-lt
printf '%s' '你的Gemini密钥' | gcloud secrets create gemini-api-key \
  --data-file=- --replication-policy=automatic        # 需先设好默认项目
./deploy/deploy.sh <PROJECT_ID>
```

> 若先跳过密钥直接部署，页面仍可运行，但「AI 工具调用轨迹」会显示"离线模式未调用工具"——
> 这会丢掉本项目最主要的差异化展示。**建议先配密钥再部署**，或配好后重跑脚本覆盖。
