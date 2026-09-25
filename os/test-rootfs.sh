#!/usr/bin/env bash
set -euo pipefail

root="$(realpath "$1")"
require_file() {
  if [ ! -e "$root/$1" ]; then
    echo "missing from live rootfs: /$1" >&2
    exit 1
  fi
}
require_executable() {
  if [ ! -x "$root/$1" ]; then
    echo "not executable in live rootfs: /$1" >&2
    exit 1
  fi
}

require_executable usr/bin/agent-workbench
require_executable usr/lib/DepDek/node
require_file usr/lib/DepDek/sidecar.mjs
require_file usr/lib/DepDek/transcribe.py
require_executable opt/depdek/venv/bin/python
require_file usr/lib/DepDek/vosk-model-small-cn-0.22/conf/model.conf
require_executable usr/bin/calamares
require_file usr/share/applications/depdek-install.desktop
grep -Fq 'Exec=pkexec calamares' "$root/usr/share/applications/depdek-install.desktop"
require_file etc/xdg/autostart/depdek-ai-os.desktop
grep -Fq 'Exec=agent-workbench' "$root/etc/xdg/autostart/depdek-ai-os.desktop"

echo "Live rootfs assertions passed: DepDek shell, sidecar, offline voice, Calamares, and autostart."
