#!/usr/bin/env bash
# 诊断「AI Studio 创建项目 permission denied」——拿到比网页更具体的错误信息
#
# 用法：
#   ./deploy/diagnose-gcp.sh              # 只读诊断，不创建任何资源
#   ./deploy/diagnose-gcp.sh --create     # 额外尝试真正创建一个项目（免费）
#
# 网页上那句 "Failed to create project: permission denied" 把真实原因吞掉了。
# gcloud 会打出实际的错误码（PERMISSION_DENIED / FAILED_PRECONDITION / ...），
# 据此才能判断是「条款未接受」「账号被当成组织」还是「配额限制」。

set -uo pipefail   # 故意不用 -e：诊断脚本要跑完全部检查再给结论

if command -v gcloud >/dev/null 2>&1; then
  GCLOUD="gcloud"
elif [[ -x "$HOME/google-cloud-sdk/bin/gcloud" ]]; then
  GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"
else
  echo "找不到 gcloud。请先安装：https://cloud.google.com/sdk/docs/install" >&2
  exit 2
fi

CREATE=0
[[ "${1:-}" == "--create" ]] && CREATE=1

hr() { printf '\n\033[1m── %s ─────────────────────────────────\033[0m\n' "$*"; }

hr "0. gcloud 版本"
$GCLOUD version 2>/dev/null | head -2

hr "1. 当前已认证的账号"
ACCOUNTS="$($GCLOUD auth list --format='value(account,status)' 2>/dev/null)"
if [[ -z "$ACCOUNTS" ]]; then
  echo "  ✗ 没有任何已认证账号。"
  echo "    请先执行：  export PATH=\"\$HOME/google-cloud-sdk/bin:\$PATH\" && gcloud auth login"
  echo "    （会打开浏览器，请确保只登录你要用的那一个 Google 账号）"
  exit 1
fi
echo "$ACCOUNTS" | sed 's/^/  /'

ACCOUNT="$($GCLOUD auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"

hr "2. 账号是否被绑定到「组织」（这是本错误最常见的原因）"
ORGS="$($GCLOUD organizations list --format='value(displayName,id)' 2>&1)"
if echo "$ORGS" | grep -qiE "listed 0 items|^$"; then
  echo "  ✓ 未绑定任何组织 → 属于个人账号，可以创建非组织项目"
  ORG_STATE="personal"
elif echo "$ORGS" | grep -qiE "permission|denied|error"; then
  echo "  ? 无法列出组织（通常也说明不是组织成员）："
  echo "$ORGS" | sed 's/^/      /'
  ORG_STATE="personal"
else
  echo "  ⚠ 账号被绑定到以下组织 —— 项目创建受组织策略管辖："
  echo "$ORGS" | sed 's/^/      /'
  ORG_STATE="org"
fi

hr "3. 当前可见的已有项目"
PROJECTS="$($GCLOUD projects list --format='value(projectId,name)' 2>&1 | head -20)"
if echo "$PROJECTS" | grep -qiE "listed 0 items|^$"; then
  echo "  （无）—— 与网页上 'No Cloud Projects Available' 一致"
  echo "     注：若账号已存在 Cloud 项目，AI Studio 不会自动建默认项目，只允许「导入」"
elif echo "$PROJECTS" | grep -qiE "permission|denied|error"; then
  echo "  ✗ 列出项目失败（这本身就是一条重要线索）："
  echo "$PROJECTS" | sed 's/^/      /'
else
  echo "$PROJECTS" | sed 's/^/  /'
fi

hr "4. 尝试创建项目（拿到真实错误）"
if [[ "$CREATE" == "1" ]]; then
  PID="gpu-waste-auditor-$(date +%Y%m%d%H%M)"
  echo "  项目 ID: $PID"
  set +e
  $GCLOUD projects create "$PID" --set-as-default 2>&1 | sed 's/^/      /'
  RC=${PIPESTATUS[0]}
  set -e
  if [[ "$RC" == "0" ]]; then
    echo "  ✓ 创建成功。接着执行："
    echo "      gcloud services enable generativelanguage.googleapis.com --project=$PID"
    echo "      gcloud alpha services api-keys create --display-name=gemini --project=$PID"
  else
    echo "  ✗ 失败（退出码 $RC）。请把上面这几行完整发我。"
  fi
else
  echo "  已跳过（只读模式）。想真正试一下请加 --create："
  echo "      $0 --create"
fi

hr "结论与下一步"
if [[ "$ORG_STATE" == "org" ]]; then
  cat <<'EOF'
  账号被当成组织处理。这种状态你自己通常改不动（论坛里有用户试过直接覆盖 org policy，无效）。
  最干净的解法是换一个全新的个人 Gmail 账号 —— 赛事并不要求 Cloud 账号与报名邮箱一致。
EOF
else
  cat <<'EOF'
  账号属个人类型，那问题多半出在这两处，按顺序试：

  A. Google Cloud 服务条款未接受 / 账号年龄验证未完成
     - 服务条款：https://console.cloud.google.com/terms
     - 年龄验证：https://myaccount.google.com/personal-info （填好出生日期）
     官方论坛回复原文即建议先完成年龄验证再重试。

  B. 绕过 AI Studio，直接在 Cloud Console 建项目和 Key（Google 官方给的 workaround）
     1) https://console.cloud.google.com/projectcreate  建项目
     2) 在该项目里启用 "Generative Language API"
     3) APIs & Services → Credentials → Create credentials → API key
     ⚠️ 第 3 步建出来的 Key 默认「无限制」，而 Gemini API 自 2026-06-19 起
        已拒绝无限制 Key（会返回 429）。建完必须进该 Key 的
        「API restrictions」把它限制为 "Generative Language API"。

  以上都走不通 → 换全新个人 Gmail 账号。
EOF
fi
