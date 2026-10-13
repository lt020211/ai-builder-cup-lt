# 部署前置条件清单

> 适用对象：本项目（Python / Flask + 自建 GitHub 仓库）
> 最后更新：2026-10-13

## 路径 A：标准 Google Cloud 项目（推荐，最灵活）

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

## 路径 B：Starter Tier（零账单，但不是万用）

资格条件（**顺序不可逆**）：

- [ ] 使用**个人 Gmail** 账号
- [ ] **从未拥有过有效的付费 Cloud Billing 账号**（一旦拥有过即永久失去资格）
- [ ] 不是 Google Workspace 账号（含付费 / 免费 / 教育 / 公益版）
- [ ] 通过 **Google AI Studio Build 模式**点发布

已知限制：每账号最多 **2 个应用**、**单一区域锁定**、API 面锁死（禁用 BigQuery / Pub/Sub / Cloud Functions）、临时文件系统、适用独立的 Starter Tier 附加条款。

⚠️ **未确认**：能否部署自带 Dockerfile 或已有仓库。官方文档只描述了「AI Studio 生成应用」这一条路径。

## 路径 C：Firebase

| 组件 | Spark（免费 · 不绑卡） | Blaze（按量 · 需绑卡） |
|---|---|---|
| Hosting 静态托管 | ✅ 10 GB 存储 / 360 MB 天 | ✅ 同额度 + 超额计费 |
| Cloud Functions | ❌ 不可用 | ✅ 200 万次调用 / 月免费 |
| **本项目可用性** | ❌ 服务端 Python **跑不了** | ✅ 可用，但等于回到绑卡路径 |

**结论**：本项目是 Python 服务端应用，Firebase Hosting 免费版只能托管静态文件，跑不了。要走 Firebase 就必须升级 Blaze 并绑卡——**没有绕开绑卡的优势**。

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

## 尚未确认的两点（部署前请实测）

1. **标准项目下 Cloud Run 是否强制要求启用 Billing**：通用规则如此，但本次抓取的 Cloud Run 定价页未明文说明。已确认的事实是 Starter Tier 下 Cloud Run 可无账单运行。
2. **Starter Tier 能否部署自带 Dockerfile / 已有仓库**：官方文档未提及，需实测。

## 最短可行路径（建议执行顺序）

1. 用个人 Gmail 试 AI Studio 能否发布 → 判断路径 B 是否可用（约 15 分钟）
2. 同时准备双币信用卡试开通 Billing → 打通路径 A（约 10 分钟）
3. 任一条打通后，按本文件 A1→A6 逐项勾选，执行 `README.md` 中的部署命令
