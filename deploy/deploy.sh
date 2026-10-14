#!/usr/bin/env bash
# 一键部署到 Cloud Run（幂等，可重复执行）
#
# 用法：
#   ./deploy/deploy.sh <PROJECT_ID> [REGION]
#
# 前置：gcloud 已安装并 `gcloud auth login` 完成，且项目已启用结算。
# 本脚本会在云端用 Cloud Build 构建镜像，**不需要本地 Docker**。
#
# 全部步骤幂等：重复执行只会更新服务，不会重复创建资源。

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-asia-east1}"
SERVICE="gpu-waste-auditor"
REPO="gpu-waste-auditor"
SECRET="gemini-api-key"

if [[ -z "$PROJECT_ID" ]]; then
  echo "用法: $0 <PROJECT_ID> [REGION]" >&2
  exit 2
fi

# 定位 gcloud：优先 PATH，退回 ~/google-cloud-sdk
if command -v gcloud >/dev/null 2>&1; then
  GCLOUD="gcloud"
elif [[ -x "$HOME/google-cloud-sdk/bin/gcloud" ]]; then
  GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"
else
  echo "找不到 gcloud。请先安装：https://cloud.google.com/sdk/docs/install" >&2
  exit 2
fi

cd "$(dirname "$0")/.."   # 切到仓库根目录（Dockerfile 所在处）

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 前置检查
say "1/6 前置检查"

ACCOUNT="$($GCLOUD auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1 || true)"
if [[ -z "$ACCOUNT" ]]; then
  echo "未登录。请先执行：  $GCLOUD auth login" >&2
  exit 1
fi
echo "  已登录账号 : $ACCOUNT"

if ! $GCLOUD projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  项目不存在或无权访问：$PROJECT_ID" >&2
  exit 1
fi
echo "  项目       : $PROJECT_ID"

BILLING="$(gcloud billing projects describe "$PROJECT_ID" \
  --format='value(billingEnabled)' 2>/dev/null || echo 'unknown')"
if [[ "$BILLING" != "True" && "$BILLING" != "true" ]]; then
  cat >&2 <<EOF
  ⚠️  该项目尚未启用结算（billingEnabled=$BILLING）

  Cloud Run 部署**强制**要求项目启用结算。请先开通：
    https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID

  开通后重跑本脚本即可（其余步骤幂等）。
EOF
  exit 1
fi
echo "  结算状态   : 已启用"

# ---------------------------------------------------------------- 启用 API
say "2/6 启用所需 API（已启用则为空操作）"
$GCLOUD services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT_ID"

# ---------------------------------------------------------------- 镜像仓库
say "3/6 确保 Artifact Registry 仓库存在"
if $GCLOUD artifacts repositories describe "$REPO" \
     --location="$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  仓库已存在：$REPO"
else
  $GCLOUD artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" --project "$PROJECT_ID"
  echo "  已创建仓库：$REPO"
fi

# ---------------------------------------------------------------- 密钥
say "4/6 检查 Gemini API Key 密钥"
SECRET_FLAG=()
if $GCLOUD secrets describe "$SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  密钥已存在：$SECRET（将挂载到容器）"
  SECRET_FLAG=(--set-secrets "GEMINI_API_KEY=${SECRET}:latest")
else
  cat <<EOF
  未找到密钥 '$SECRET'。
  ⚠️  不配置也能部署，但页面上「AI 工具调用轨迹」会显示"离线模式未调用工具"——
      这会丢掉本项目最主要的差异化展示。建议先执行：

      printf '%s' '你的Gemini密钥' | $GCLOUD secrets create $SECRET \\
        --data-file=- --project=$PROJECT_ID --replication-policy=automatic

      然后重跑本脚本。现在先以离线模式继续部署。
EOF
fi

# ---------------------------------------------------------------- 部署
say "5/6 部署到 Cloud Run（云端构建，无需本地 Docker）"
$GCLOUD run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --cpu 1 \
  --memory 512Mi \
  --timeout 180 \
  --concurrency 40 \
  --set-env-vars "GEMINI_MODEL=gemini-2.5-flash" \
  ${SECRET_FLAG[@]+"${SECRET_FLAG[@]}"}

# ---------------------------------------------------------------- 验证
say "6/6 部署后验证"
URL="$($GCLOUD run services describe "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "  服务地址 : $URL"

echo "  /healthz        -> $(curl -s -m 20 "$URL/healthz" || echo '（冷启动中，稍后重试）')"
echo -n "  /api/carbon-profile -> "
curl -s -m 30 "$URL/api/carbon-profile" | head -c 120 || echo "（冷启动中，稍后重试）"
echo
echo -n "  /api/analyze    -> "
curl -s -m 60 -X POST "$URL/api/analyze" -H 'Content-Type: application/json' -d '{}' \
  | head -c 200 || echo "（冷启动中，稍后重试）"
cat <<EOF

完成。可公开访问的地址（提交物需要的就是这个）：

    $URL

⚠️ 若 /api/analyze 返回中 ai.mode 为 "offline"，说明密钥未挂载，
   页面的「AI 工具调用轨迹」会是空——请在配好密钥后重跑本脚本。
EOF
