#!/bin/bash
set -e
cd "$(dirname "$0")"

# 启动 Python HTTP server 提供 renderer 文件
python3 -m http.server 18925 --directory renderer &
HTTP_PID=$!
sleep 1

# 设置环境变量并启动 Electron
ELECTRON_RENDERER_URL=http://127.0.0.1:18925/index.html \
  AKM_DATA_DIR="${AKM_DATA_DIR:-$HOME/.config/api-key-manager}" \
  ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9400 "$@"

# Electron 退出后关闭 HTTP server
kill $HTTP_PID 2>/dev/null || true
