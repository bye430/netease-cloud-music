#!/usr/bin/env bash
# deb 安装后刷新桌面数据库，使应用中心能立即看到启动入口
set -euo pipefail

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
