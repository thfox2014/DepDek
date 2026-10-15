#!/usr/bin/env bash
set -euo pipefail

root="$(realpath "$1")"
require_file() {
  # Absolute links in an unpacked rootfs resolve inside that rootfs at boot,
  # not against the builder's /usr (which need not contain a display manager).
  if [ -L "$root/$1" ]; then
    local target
    target=$(readlink "$root/$1")
    if [[ "$target" = /* ]] && [ -e "$root$target" ]; then
      return
    fi
  fi
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
require_executable usr/local/bin/depdek-shell
require_file usr/share/depdek/depdek-shell
require_file usr/share/depdek/depdek-welcome.sh
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
test "$(readlink "$root/etc/systemd/system/default.target")" = /lib/systemd/system/graphical.target
require_executable usr/bin/startx
require_file usr/lib/systemd/system/graphical.target
require_file etc/systemd/system/display-manager.service
require_file etc/systemd/system/jiaho-session-user.service
require_file etc/systemd/system/jiaho-model.service
require_executable usr/lib/jiaho/select-session-user
require_executable usr/lib/jiaho/llama-server
require_file usr/share/jiaho/models/setup.gguf
require_file usr/share/plymouth/themes/jiaho/jiaho.plymouth
require_file usr/share/plymouth/themes/jiaho/jiaho-logo.png
grep -Fq '127.0.0.1' "$root/etc/systemd/system/jiaho-model.service"
printf '%s  %s\n' 74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db "$root/usr/share/jiaho/models/setup.gguf" | sha256sum -c -
if ! dpkg-query --admindir="$root/var/lib/dpkg" -W -f='${Status}' user-setup 2>/dev/null | grep -Fq 'install ok installed'; then
  echo "live user autologin support is missing" >&2
  exit 1
fi

echo "Live rootfs assertions passed: Jiaho splash, graphical login shell, verified local AI, offline voice, CLI fallback, and Calamares."
