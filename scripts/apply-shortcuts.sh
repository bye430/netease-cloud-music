#!/usr/bin/env bash
# 根据配置文件注册 GNOME 自定义快捷键（无需 root）
set -euo pipefail

CONFIG_JSON="${1:-}"
if [[ -z "$CONFIG_JSON" || ! -f "$CONFIG_JSON" ]]; then
  echo "用法: apply-shortcuts.sh <shortcuts-config.json>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CONFIG_JSON
export APP_DIR="$(dirname "$SCRIPT_DIR")"
python3 <<'PY'
import json
import os
import subprocess
import sys

config_path = os.environ["CONFIG_JSON"]
with open(config_path, encoding="utf-8") as f:
    config = json.load(f)

schema = "org.gnome.settings-daemon.plugins.media-keys"
base = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/netease-music-"
ours = {base + s + "/" for s in ("play-pause", "next", "prev")}

if os.path.isfile("/usr/local/bin/netease-music-ctl"):
    ctl = "/usr/local/bin/netease-music-ctl"
else:
    config_dir = os.path.expanduser("~/.config/netease-music-desktop")
    app_dir = None
    conf = os.path.join(config_dir, "app-path.conf")
    if os.path.isfile(conf):
        with open(conf, encoding="utf-8") as f:
            for line in f:
                if line.startswith("APP_DIR="):
                    app_dir = line.strip().split("=", 1)[1]
                    break
    if not app_dir:
        app_dir = os.environ.get("APP_DIR")
    electron = os.path.join(app_dir, "node_modules", ".bin", "electron")
    ctl = f'{electron} --no-sandbox {app_dir} --control'

actions = [
    ("play-pause", "网易云音乐 播放/暂停", "play-pause", config.get("playPause", "")),
    ("next", "网易云音乐 下一首", "next", config.get("next", "")),
    ("prev", "网易云音乐 上一首", "prev", config.get("prev", "")),
]

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

paths = [p for p in paths if p not in ours]

for suffix, name, cmd, binding in actions:
    path = base + suffix + "/"
    custom = schema + ".custom-keybinding:" + path
    if not binding:
        continue
    subprocess.run(["gsettings", "set", custom, "name", name], check=True)
    if ctl.endswith("--control"):
        command = f"{ctl}={cmd}"
    else:
        command = f"{ctl} {cmd}"
    subprocess.run(["gsettings", "set", custom, "command", command], check=True)
    subprocess.run(["gsettings", "set", custom, "binding", binding], check=True)
    if path not in paths:
        paths.append(path)

new_value = "[" + ", ".join(f"'{p}'" for p in paths) + "]"
subprocess.run(["gsettings", "set", schema, "custom-keybindings", new_value], check=True)
print("系统快捷键已应用。")
PY
