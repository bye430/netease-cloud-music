#!/usr/bin/env bash
# 向正在运行的网易云音乐桌面版发送播放控制命令
set -euo pipefail

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "用法: netease-music-ctl <play-pause|next|prev|show>" >&2
  exit 1
fi

case "$ACTION" in
  play-pause|next|prev|show) ;;
  *)
    echo "未知命令: $ACTION" >&2
    exit 1
    ;;
esac

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/netease-music-desktop"
CONFIG_FILE="$CONFIG_DIR/app-path.conf"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

if [[ -z "${APP_DIR:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP_DIR="$(dirname "$SCRIPT_DIR")"
fi

ELECTRON="$APP_DIR/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON" ]]; then
  echo "找不到 Electron: $ELECTRON" >&2
  echo "请先在应用内打开「快捷键设置」并执行「安装系统命令」。" >&2
  exit 1
fi

exec "$ELECTRON" --no-sandbox "$APP_DIR" "--control=$ACTION"
