#!/usr/bin/env bash
# Update only the bundled application in an already validated Debian Live ISO.
# Run inside the amd64 OS builder with the same privileges as live-build.
set -euo pipefail
base=$(realpath "$1")
deb=$(realpath "$2")
output=$(realpath -m "$3")
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test "$base" != "$output"
test ! -e "$output"
test "$(dpkg-deb -f "$deb" Architecture)" = amd64
test "$(dpkg-deb -f "$deb" Package)" = dep-dek
compressor=${DEPDEK_SQUASHFS_COMPRESSOR:-xz}
case "$compressor" in xz|zstd) ;; *) echo "Unsupported SquashFS compressor" >&2; exit 1 ;; esac
work=$(mktemp -d /tmp/jiaho-app-remaster.XXXXXX)
cleanup() {
  case "$work" in /tmp/jiaho-app-remaster.*) rm -rf -- "$work" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

xorriso -osirrox on -indev "$base" \
  -extract /live/filesystem.squashfs "$work/base.squashfs" \
  -extract /sha256sum.txt "$work/sha256sum.txt"
unsquashfs -processors 2 -data-queue 32 -frag-queue 32 -d "$work/rootfs" "$work/base.squashfs"
rm "$work/base.squashfs"
install -m 0644 "$deb" "$work/rootfs/tmp/jiaho-update.deb"
chroot "$work/rootfs" dpkg -i /tmp/jiaho-update.deb
rm "$work/rootfs/tmp/jiaho-update.deb"
bash "$repo/os/test-rootfs.sh" "$work/rootfs"
binary_path=$(dpkg-deb --fsys-tarfile "$deb" | tar -tf - | awk '$0 == "usr/bin/agent-workbench" || $0 == "./usr/bin/agent-workbench" { print; found = 1 } END { if (!found) exit 1 }')
expected=$(dpkg-deb --fsys-tarfile "$deb" | tar -xOf - "$binary_path" | sha256sum | cut -d' ' -f1)
printf '%s  %s\n' "$expected" "$work/rootfs/usr/bin/agent-workbench" | sha256sum -c -
compression_args=(-comp "$compressor")
if [ "$compressor" = zstd ]; then
  grep -q '^CONFIG_SQUASHFS_ZSTD=y$' "$work/rootfs"/boot/config-*
  compression_args+=(-Xcompression-level 3)
fi
mksquashfs "$work/rootfs" "$work/filesystem.squashfs" -noappend "${compression_args[@]}" -processors 2 -mem 256M
digest=$(sha256sum "$work/filesystem.squashfs" | cut -d' ' -f1)
grep -Eq ' \*?(\./)?live/filesystem.squashfs$' "$work/sha256sum.txt"
awk -v digest="$digest" '/ \*?(\.\/)?live\/filesystem.squashfs$/ { print digest "  " $2; next } { print }' \
  "$work/sha256sum.txt" > "$work/sha256sum.updated.txt"
mkdir -p "$(dirname "$output")"
xorriso -indev "$base" -outdev "$output.partial" -boot_image any replay \
  -map "$work/filesystem.squashfs" /live/filesystem.squashfs \
  -map "$work/sha256sum.updated.txt" /sha256sum.txt
xorriso -indev "$output.partial" -report_el_torito plain
file "$output.partial" | grep -q bootable
mv "$output.partial" "$output"
sha256sum "$output"
