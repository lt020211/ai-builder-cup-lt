#!/usr/bin/env bash
# 本地一键启动：建虚拟环境、装依赖、跑测试、起服务
set -euo pipefail

cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "==> 创建虚拟环境 .venv"
"$PYTHON_BIN" -m venv .venv

echo "==> 安装依赖"
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt

echo "==> 运行单元测试"
./.venv/bin/python -m unittest discover -s tests -v

echo "==> 启动服务（Ctrl+C 停止）"
echo "    浏览器打开 http://127.0.0.1:${PORT:-8080}"
exec ./.venv/bin/python -m src.app
