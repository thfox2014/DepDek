#!/usr/bin/env bash
# Update only the bundled application in an already validated Debian Live ISO.
# Run inside the amd64 OS builder with the same privileges as live-build.
set -euo pipefail
base=$(realpath "$1")
deb=$(realpath "$2")
output=$(realpath -m "$3")
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
overlay=${4:-}
case "$overlay" in ''|--with-startup) ;; *) echo "Unknown remaster option" >&2; exit 1 ;; esac
test "$base" != "$output"
test ! -e "$output"
test "$(dpkg-deb -f "$deb" Architecture)" = amd64
test "$(dpkg-deb -f "$deb" Package)" = dep-dek
compressor=${DEPDEK_SQUASHFS_COMPRESSOR:-xz}
case "$compressor" in xz|zstd) ;; *) echo "Unsupported SquashFS compressor" >&2; exit 1 ;; esac
work=$(mktemp -d /tmp/jiaho-app-remaster.XXXXXX)
cleanup() {
  if mountpoint -q "$work/rootfs"; then umount "$work/rootfs"; fi
  case "$work" in /tmp/jiaho-app-remaster.*) rm -rf -- "$work" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
if [ "${DEPDEK_ROOTFS_TMPFS:-0}" = 1 ]; then
  # Opt-in for low-disk builders. Run with a >=6 GiB cgroup limit; only the
  # uncompressed staged tree is held in RAM, compressed/output images use disk.
  mkdir "$work/rootfs"
  mount -t tmpfs -o size=5G tmpfs "$work/rootfs"
fi

# An ISO file can be read at its single contiguous SquashFS extent. Validate
# that layout instead of temporarily copying another multi-gigabyte image.
layout=$(xorriso -indev "$base" -find /live/filesystem.squashfs -exec report_lba -- 2>/dev/null | awk -F, '/^File data lba:/ { gsub(/ /,"",$2); gsub(/ /,"",$4); print $2, $4 }')
test "$(printf '%s\n' "$layout" | wc -l)" -eq 1
read -r lba source_bytes <<< "$layout"
[[ "$lba" =~ ^[0-9]+$ && "$source_bytes" =~ ^[0-9]+$ ]]
offset=$((lba * 2048))
test "$offset" -gt 0
test "$((offset + source_bytes))" -le "$(stat -c '%s' "$base")"
unsquashfs -offset "$offset" -s "$base"
xorriso -osirrox on -indev "$base" -extract /sha256sum.txt "$work/sha256sum.txt"
unsquashfs -offset "$offset" -processors 2 -data-queue 32 -frag-queue 32 -d "$work/rootfs" "$base"
install -m 0644 "$deb" "$work/rootfs/tmp/jiaho-update.deb"
chroot "$work/rootfs" dpkg -i /tmp/jiaho-update.deb
rm "$work/rootfs/tmp/jiaho-update.deb"
if [ "$overlay" = --with-startup ]; then
  bash "$repo/os/install-startup.sh" "$work/rootfs"
fi
bash "$repo/os/test-rootfs.sh" "$work/rootfs"
bash "$repo/os/test-vosk.sh" "$work/rootfs" "$repo/os/tests/fixtures/mandarin-mvp.wav"
binary_path=$(dpkg-deb --fsys-tarfile "$deb" | tar -tf - | awk '$0 == "usr/bin/agent-workbench" || $0 == "./usr/bin/agent-workbench" { print; found = 1 } END { if (!found) exit 1 }')
expected=$(dpkg-deb --fsys-tarfile "$deb" | tar -xOf - "$binary_path" | sha256sum | cut -d' ' -f1)
printf '%s  %s\n' "$expected" "$work/rootfs/usr/bin/agent-workbench" | sha256sum -c -
compression_args=(-comp "$compressor")
if [ "$compressor" = zstd ]; then
  grep -q '^CONFIG_SQUASHFS_ZSTD=y$' "$work/rootfs"/boot/config-*
  compression_args+=(-Xcompression-level 3)
fi
mksquashfs "$work/rootfs" "$work/filesystem.squashfs" -noappend "${compression_args[@]}" -processors 2 -mem 256M
# All validations have completed. Release only this disposable extracted rootfs
# before writing a second ISO, keeping peak disk use bounded on the host.
if mountpoint -q "$work/rootfs"; then
  umount "$work/rootfs"
  rmdir "$work/rootfs"
else
  rm -rf -- "$work/rootfs"
fi
digest=$(sha256sum "$work/filesystem.squashfs" | cut -d' ' -f1)
grep -Eq ' \*?(\./)?live/filesystem.squashfs$' "$work/sha256sum.txt"
awk -v digest="$digest" '/ \*?(\.\/)?live\/filesystem.squashfs$/ { print digest "  " $2; next } { print }' \
  "$work/sha256sum.txt" > "$work/sha256sum.updated.txt"
mkdir -p "$(dirname "$output")"
# Account for both the compressed staging file and the final ISO. Host bind
# mounts report actual host free space; reserve 1 GiB instead of filling macOS.
required=$(( $(stat -c '%s' "$base") - source_bytes + $(stat -c '%s' "$work/filesystem.squashfs") + 64 * 1024 * 1024 ))
space_deadline=$((SECONDS + 600))
space_notice=0
while :; do
  available=$(df -Pk "$(dirname "$output")" | awk 'END { print $4 }')
  [[ "$available" =~ ^[0-9]+$ ]]
  if [ "$((available * 1024))" -ge "$((required + 1024 * 1024 * 1024))" ]; then break; fi
  if [ "$space_notice" = 0 ]; then
    printf 'Waiting for host disk space: need %s bytes plus 1 GiB reserve; %s KiB available. No old media will be removed.\n' "$required" "$available"
    space_notice=1
  fi
  [ "$SECONDS" -lt "$space_deadline" ] || { echo "Insufficient safe output space" >&2; exit 1; }
  sleep 10
done
xorriso -indev "$base" -outdev "$output.partial" -boot_image any replay \
  -map "$work/filesystem.squashfs" /live/filesystem.squashfs \
  -map "$work/sha256sum.updated.txt" /sha256sum.txt
xorriso -indev "$output.partial" -report_el_torito plain
file "$output.partial" | grep -q bootable
mv "$output.partial" "$output"
sha256sum "$output"
