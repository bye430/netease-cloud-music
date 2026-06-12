#!/usr/bin/env bash
# 从系统字体目录复制歌词悬浮窗用字体到 assets/fonts/
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT_DIR/assets/fonts"
mkdir -p "$DEST"

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dest"
    echo "已复制: $(basename "$dest")"
  else
    echo "跳过（不存在）: $src" >&2
  fi
}

copy_if_exists /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc "$DEST/NotoSansSC-Regular.ttc"
copy_if_exists /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc "$DEST/NotoSansSC-Bold.ttc"
copy_if_exists /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc "$DEST/WenQuanYi-ZenHei.ttc"

echo "字体安装完成: $DEST"
