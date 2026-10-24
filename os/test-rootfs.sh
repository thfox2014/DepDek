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
require_executable usr/local/bin/jiaho
require_executable usr/lib/jiaho/start-session
require_executable usr/bin/flock
require_executable usr/bin/pkill
require_executable usr/bin/xsetroot
require_executable usr/bin/dbus-run-session
require_executable usr/bin/xfwm4
require_executable usr/bin/xfsettingsd
require_executable usr/bin/startplasma-x11
require_file usr/share/xsessions/plasmax11.desktop
require_file etc/X11/xinit/xinputrc
grep -Fq 'run_im fcitx5' "$root/etc/X11/xinit/xinputrc"
require_file etc/skel/.config/fcitx5/profile
grep -Fxq 'DefaultIM=pinyin' "$root/etc/skel/.config/fcitx5/profile"
require_executable usr/libexec/polkit-mate-authentication-agent-1
require_file usr/share/xsessions/jiaho.desktop
require_file usr/share/applications/jiaho.desktop
require_executable etc/skel/Desktop/jiaho.desktop
grep -Fq 'Exec=/usr/lib/jiaho/start-session' "$root/usr/share/xsessions/jiaho.desktop"
grep -Fq 'Name=家合 AI-OS' "$root/usr/share/applications/jiaho.desktop"
grep -Fq 'Exec=/usr/local/bin/jiaho' "$root/usr/share/applications/jiaho.desktop"
grep -Fq 'Exec=/usr/local/bin/jiaho' "$root/etc/skel/Desktop/jiaho.desktop"
grep -Fq 'autologin-session=plasmax11' "$root/usr/lib/jiaho/select-session-user"
grep -Fq 'user-session=plasmax11' "$root/usr/lib/jiaho/select-session-user"
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
if [ -e "$root/etc/xdg/autostart/depdek-ai-os.desktop" ]; then
  echo "Jiaho must not auto-launch over the KDE desktop" >&2
  exit 1
fi
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
grep -Fxq 'Type=XSession' "$root/usr/share/xsessions/plasmax11.desktop"
grep -Fxq 'Exec=/usr/bin/startplasma-x11' "$root/usr/share/xsessions/plasmax11.desktop"
grep -Fxq 'DesktopNames=KDE' "$root/usr/share/xsessions/plasmax11.desktop"
for package in plasma-desktop plasma-workspace kwin-x11 dolphin konsole systemsettings plasma-nm plasma-pa fcitx5 fcitx5-chinese-addons fcitx5-frontend-gtk3 fcitx5-frontend-qt6 im-config; do
  if ! dpkg-query --admindir="$root/var/lib/dpkg" -W -f='${Status}' "$package" 2>/dev/null | grep -Fq 'install ok installed'; then
    echo "required Plasma/Chinese input package is missing: $package" >&2
    exit 1
  fi
done

echo "Live rootfs assertions passed: Jiaho splash, default Plasma X11, manual Jiaho launchers, Fcitx5 Pinyin, private login, verified local AI, offline voice, desktop recovery, and Calamares."
