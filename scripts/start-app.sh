#!/usr/bin/env bash
#
# 免安裝啟動器（Linux / macOS）：啟動公文系統伺服器並開啟瀏覽器。
# 需求：已安裝 Node.js。直接雙擊或於終端機執行皆可。
#
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝：https://nodejs.org/"
  exit 1
fi

echo "啟動公文系統… ${URL}"
PORT="$PORT" node server.js &
SERVER_PID=$!

# 等伺服器就緒後開啟瀏覽器
sleep 1
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
fi

trap 'kill $SERVER_PID 2>/dev/null' INT TERM
wait $SERVER_PID
