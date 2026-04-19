#!/bin/bash
set -e

cd "$(dirname "$0")"

# 检查 .env 是否存在
if [ ! -f .env ]; then
  echo "未找到 .env 文件，请先复制 .env.example 并填写配置："
  echo "  cp .env.example .env"
  echo "  然后编辑 .env 填入 POLYMARKET_PRIVATE_KEY 和 POLYMARKET_PROXY_ADDRESS"
  exit 1
fi

# 安装依赖
if [ ! -d node_modules ]; then
  echo "正在安装依赖..."
  npm install
fi

# 如果端口已被占用，先杀掉旧进程
if lsof -ti:3456 > /dev/null 2>&1; then
  echo "端口 3456 已被占用，正在关闭旧进程..."
  lsof -ti:3456 | xargs kill -9
  sleep 1
fi

echo "启动 BTC 5m 盘口监控..."
APP_MODE=$(grep -E '^APP_MODE=' .env | tail -n1 | cut -d= -f2 | tr -d '\r' | tr -d '"')
if [ -z "$APP_MODE" ]; then
  APP_MODE="full"
fi
echo "运行模式: $APP_MODE"
echo "状态接口: http://localhost:3456/api/state"
if [ "$APP_MODE" != "headless" ]; then
  echo "浏览器地址: http://localhost:3456"
fi
echo "按 Ctrl+C 退出"
echo ""

# 退出时清理所有子进程
trap 'kill -- -$$ 2>/dev/null; exit 0' INT TERM EXIT

# 等服务就绪后自动打开浏览器
if [ "$APP_MODE" != "headless" ] && [ "$(uname -s)" = "Darwin" ]; then
  (
    sleep 2
    URL="http://localhost:3456"
    open "$URL" >/dev/null 2>&1 || true
  ) &
fi

npx tsx server.ts
