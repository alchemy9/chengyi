#!/bin/bash
# 双击启动承艺：后台（承艺 AI、语音、作品同步）与网页一起启动，浏览器自动打开。
# 找不到 Python 3.12 时退回纯网页预览：其余功能都在，承艺 AI 改用本机关键词理解。
cd "$(dirname "$0")" || exit 1
cd server || exit 1
# server/runtime 自带运行环境时直接用它，不用装 Python。
for bundled in runtime/python/bin/python3 runtime/python/bin/python3.12; do
  if [ -x "$bundled" ]; then
    exec "$bundled" scripts/launch_shared.py
  fi
done
for candidate in python3.14 python3.13 python3.12 python3 \
  /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 \
  /usr/local/bin/python3.14 /usr/local/bin/python3.13 /usr/local/bin/python3.12 \
  /Library/Frameworks/Python.framework/Versions/3.1*/bin/python3 \
  "$PWD/.venv/bin/python"; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 12))' >/dev/null 2>&1; then
    "$candidate" scripts/launch_shared.py
    status=$?
    if [ "$status" -ne 0 ]; then
      read -r -p "按回车关闭窗口。"
    fi
    exit "$status"
  fi
done
cd ..
if command -v python3 >/dev/null 2>&1; then
  PORT=5180
  echo "没有找到 Python 3.12 或更新版本，先以纯网页方式预览：http://localhost:$PORT"
  echo "（承艺 AI 使用本机关键词理解。安装 Python 3.12 以上后重新双击，即可连接后台。）"
  echo "关闭这个窗口即可停止预览。"
  (sleep 1 && open "http://localhost:$PORT") &
  exec python3 tools/serve.py $PORT
fi
echo "没有找到 Python。请打开 https://www.python.org/downloads/ 安装 Python 3.12 以上版本，装好后再双击本文件。"
read -r -p "按回车关闭窗口。"
exit 1
