#!/usr/bin/env bash
# Install only the reviewed startup overlay into a disposable Debian rootfs.
# Never targets the running host and never copies Home/credentials/build caches.
set -euo pipefail
root=$(realpath "${1:?unpacked Debian rootfs required}")
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test "$(id -u)" = 0
case "$root" in /tmp/jiaho-app-remaster.*/rootfs) ;; *) echo "Refusing a non-remaster rootfs target" >&2; exit 1 ;; esac
test -x "$root/usr/bin/agent-workbench"
grep -Fxq 'ID=debian' "$root/etc/os-release"
grep -Eq '^VERSION_ID="?13"?$' "$root/etc/os-release"
for package in plasma-desktop plasma-workspace kwin-x11 dolphin konsole systemsettings plasma-nm plasma-pa fcitx5 fcitx5-chinese-addons fcitx5-frontend-gtk3 fcitx5-frontend-qt6 im-config; do
  if ! chroot "$root" dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -Fq 'install ok installed'; then
    echo "base ISO lacks required Plasma/Chinese input package: $package; build a new Debian base first" >&2
    exit 1
  fi
done
source_root="$repo/os/live/config/includes.chroot"
for path in \
  usr/local/bin/jiaho \
  usr/lib/jiaho/start-session \
  usr/lib/jiaho/select-session-user \
  usr/share/depdek/depdek-shell; do
  install -D -m 0755 "$source_root/$path" "$root/$path"
done
for path in \
  usr/share/depdek/depdek-welcome.sh \
  usr/share/xsessions/jiaho.desktop \
  usr/share/applications/jiaho.desktop \
  etc/systemd/system/jiaho-session-user.service \
  etc/skel/.config/fcitx5/profile; do
  install -D -m 0644 "$source_root/$path" "$root/$path"
done
install -D -m 0755 "$source_root/usr/share/applications/jiaho.desktop" "$root/etc/skel/Desktop/jiaho.desktop"
# The base ISO may have the previous full-screen auto-launch policy. Remove it
# from this staged image so Plasma remains visible until the user opens Jiaho.
rm -f "$root/etc/xdg/autostart/depdek-ai-os.desktop"
install -D -m 0755 "$source_root/usr/share/depdek/depdek-shell" "$root/usr/local/bin/depdek-shell"
install -D -m 0644 "$source_root/usr/share/depdek/depdek-welcome.sh" "$root/etc/profile.d/depdek-welcome.sh"
ln -sfn /lib/systemd/system/graphical.target "$root/etc/systemd/system/default.target"
systemctl --root="$root" enable lightdm.service jiaho-session-user.service jiaho-model.service
chroot "$root" desktop-file-validate /usr/share/xsessions/jiaho.desktop /usr/share/applications/jiaho.desktop
chroot "$root" im-config -n fcitx5
chroot "$root" desktop-file-validate /usr/share/xsessions/plasmax11.desktop
echo "Jiaho startup overlay installed into staged rootfs; host services and old media are unchanged."
