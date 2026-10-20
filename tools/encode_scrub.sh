#!/bin/bash
# 把视频模型生成的过场转成适合“随滚动逐帧播放”的格式：全关键帧、无声、1672 宽、30fps。
# 用法：tools/encode_scrub.sh 输入.mp4 assets/story/video/v4-glaze-push-in.mp4
# 需要 ffmpeg（brew install ffmpeg）。
set -e
in="$1"; out="$2"
[ -z "$in" ] || [ -z "$out" ] && { echo "用法：$0 输入.mp4 输出.mp4"; exit 1; }
mkdir -p "$(dirname "$out")"
ffmpeg -y -i "$in" -an -vf "scale=1672:-2:flags=lanczos,fps=30" \
  -c:v libx264 -preset slow -crf 20 -g 1 -keyint_min 1 -pix_fmt yuv420p -movflags +faststart "$out"
echo "已生成：$out"
# 登记到 index.json，网页据此启用这段视频
idx="$(dirname "$out")/index.json"
name="$(basename "$out")"
python3 - "$idx" "$name" <<'PY'
import json, sys, os
p, n = sys.argv[1], sys.argv[2]
lst = json.load(open(p)) if os.path.exists(p) else []
if n not in lst: lst.append(n)
json.dump(sorted(lst), open(p, 'w'), ensure_ascii=False)
print('已登记：', n)
PY
