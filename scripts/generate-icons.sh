#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/icon.png"
OUT="$ROOT/build/icons"

if [[ ! -f "$SRC" ]]; then
  echo "缺少图标源文件: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT"
for size in 16 32 48 64 128 256 512; do
  convert "$SRC" -resize "${size}x${size}" "$OUT/${size}x${size}.png"
done

cp "$SRC" "$ROOT/build/icon.png"
