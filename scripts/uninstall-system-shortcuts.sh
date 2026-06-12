#!/usr/bin/env bash
# 需要 root：移除系统级控制命令，并清理 GNOME 快捷键
set -euo pipefail

if [[ -f /usr/local/bin/netease-music-ctl ]]; then
  rm -f /usr/local/bin/netease-music-ctl
  echo "已移除: /usr/local/bin/netease-music-ctl"
else
  echo "系统命令未安装，跳过。"
fi

cleanup_py() {
  python3 <<'PY'
import subprocess

schema = "org.gnome.settings-daemon.plugins.media-keys"
prefix = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/netease-music-"
ours = {prefix + s + "/" for s in ("play-pause", "next", "prev")}

result = subprocess.run(
    ["gsettings", "get", schema, "custom-keybindings"],
    capture_output=True,
    text=True,
    check=True,
)
raw = result.stdout.strip()
if raw in ("@as []", "[]"):
    paths = []
else:
    inner = raw.strip("[]")
    paths = [p.strip().strip("'") for p in inner.split(",") if p.strip()]

kept = [p for p in paths if p not in ours]
new_value = "[" + ", ".join(f"'{p}'" for p in kept) + "]"
subprocess.run(["gsettings", "set", schema, "custom-keybindings", new_value], check=True)
print("已清理 GNOME 自定义快捷键中的网易云条目。")
PY
}

if [[ -n "${SUDO_USER:-}" ]]; then
  sudo -u "$SUDO_USER" -H bash -c "$(declare -f cleanup_py); cleanup_py"
else
  cleanup_py
fi
