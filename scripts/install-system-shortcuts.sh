#!/usr/bin/env bash
# 需要 root：将控制脚本安装到系统 PATH
set -euo pipefail

APP_DIR="${1:-}"
if [[ -z "$APP_DIR" || ! -d "$APP_DIR" ]]; then
  echo "用法: sudo install-system-shortcuts.sh <应用目录>" >&2
  exit 1
fi

SCRIPT_DIR="$APP_DIR/scripts"
CTL_SRC="$SCRIPT_DIR/netease-music-ctl.sh"
if [[ ! -f "$CTL_SRC" ]]; then
  echo "找不到 $CTL_SRC" >&2
  exit 1
fi

CONFIG_DIR="${SUDO_USER:+/home/$SUDO_USER/.config/netease-music-desktop}"
if [[ -z "$CONFIG_DIR" ]]; then
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/netease-music-desktop"
fi

mkdir -p "$CONFIG_DIR"
echo "APP_DIR=$APP_DIR" > "$CONFIG_DIR/app-path.conf"
if [[ -n "${SUDO_USER:-}" ]]; then
  chown "$SUDO_USER:$SUDO_USER" "$CONFIG_DIR/app-path.conf"
fi

install -m 755 "$CTL_SRC" /usr/local/bin/netease-music-ctl
echo "已安装: /usr/local/bin/netease-music-ctl"
echo "应用路径: $APP_DIR"
