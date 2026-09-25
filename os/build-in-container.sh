#!/usr/bin/env bash
set -euo pipefail

src=/workspace
work=/tmp/depdek-mvp
out="$src/os/artifacts"
mkdir -p "$work" "$out"
tar -C "$src" \
  --exclude=.git --exclude=node_modules --exclude=sidecar/node_modules \
  --exclude=dist --exclude=src-tauri/target --exclude=os/artifacts --exclude=os/.cache --exclude=__pycache__ \
  -cf - . | tar -C "$work" -xf -
mkdir -p "$work/os/live"
ln -sfn /live-cache "$work/os/live/cache"

cd "$work"
if [ -n "${DEPDEK_PREBUILT_DEB:-}" ]; then
  deb=$(realpath "$DEPDEK_PREBUILT_DEB")
  test "$(dpkg-deb -f "$deb" Architecture)" = amd64
else
  npm ci
  npm --prefix sidecar ci

  # Bundle the Apache-2.0 Mandarin model so recognition works offline.
  mkdir -p src-tauri/resources
  model_zip=/tmp/vosk-model-small-cn-0.22.zip
  curl --fail --location --retry 3 --output "$model_zip" \
    https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
  unzip -q "$model_zip" -d src-tauri/resources
  rm "$model_zip"

  VITE_DEPDEK_OS=1 npm run tauri -- build --bundles deb
  deb=$(find src-tauri/target/release/bundle/deb -maxdepth 1 -name '*.deb' -print -quit)
  test -n "$deb"
fi
if [ "$deb" != "$out/depdek-ai-os-amd64.deb" ]; then
  cp "$deb" "$out/depdek-ai-os-amd64.deb"
fi
mkdir -p os/live/config/includes.chroot/usr/share/depdek
mkdir -p os/live/config/packages.chroot
install -D "$deb" os/live/config/packages.chroot/depdek-ai-os_amd64.deb

cd os/live
lb config \
  --mode debian \
  --distribution trixie \
  --architectures amd64 \
  --binary-images iso-hybrid \
  --cache true \
  --cache-stages "bootstrap rootfs" \
  --firmware-chroot false \
  --mirror-bootstrap https://deb.debian.org/debian \
  --mirror-chroot https://deb.debian.org/debian \
  --mirror-chroot-security https://security.debian.org/debian-security \
  --archive-areas "main contrib non-free-firmware" \
  --bootappend-live "boot=live components nocomponents=locales username=live hostname=depdek quiet splash console=ttyS0,115200n8" \
  --bootloaders "grub-pc grub-efi"
lb build

bash "$src/os/test-rootfs.sh" "$PWD/chroot"
bash "$src/os/test-vosk.sh" "$PWD/chroot" "$src/os/tests/fixtures/mandarin-mvp.wav"

iso=$(find . -maxdepth 1 -name '*.iso' -print -quit)
test -n "$iso"
cp "$iso" "$out/DepDek-AI-OS-amd64.iso"
