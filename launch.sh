#!/bin/bash
# API Key Manager 启动脚本
cd "$(dirname "$0")/Contents/Resources/app"

# 启动 HTTP 服务器提供 renderer 文件
python3 -m http.server 18925 --directory renderer > /dev/null 2>&1 &
HTTP_PID=$!

# 设置环境变量并启动 Electron
ELECTRON_RENDERER_URL=http://127.0.0.1:18925/index.html \
  exec "./node_modules/.bin/electron" . "$@"

# Electron 退出后关闭 HTTP 服务器
kill $HTTP_PID 2>/dev/null || true
