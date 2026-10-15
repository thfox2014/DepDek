#!/usr/bin/env bash
set -euo pipefail
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export CARGO_TARGET_DIR=/cargo-cache

src=/workspace
work=/tmp/depdek-mvp
out="$src/os/artifacts"
mkdir -p "$work" "$out"
tar -C "$src" \
  --exclude=.git --exclude=node_modules --exclude=target --exclude=dist \
  --exclude=.tools --exclude=os/artifacts --exclude=os/.cache --exclude=__pycache__ \
  --exclude=webdesk/.run --exclude=webdesk/.run-shot \
  --exclude=.env --exclude='.env.*' --exclude=.preview-token \
  --exclude=src-tauri/resources/node \
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
  model_dir=src-tauri/resources/vosk-model-small-cn-0.22
  if [ -s "$model_dir/am/final.mdl" ] && [ -s "$model_dir/conf/model.conf" ] \
    && [ -s "$model_dir/graph/HCLr.fst" ] && [ -s "$model_dir/graph/Gr.fst" ]; then
    echo "Using bundled vosk-model-small-cn-0.22 (offline loading is tested below)."
  else
    model_zip=/tmp/vosk-model-small-cn-0.22.zip
    curl --fail --location --retry 3 --retry-all-errors \
      --connect-timeout 20 --max-time 600 --speed-time 30 --speed-limit 1024 \
      --silent --show-error --output "$model_zip" \
      https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
    unzip -oq "$model_zip" -d src-tauri/resources
    rm "$model_zip"
  fi

  VITE_DEPDEK_OS=1 npm run tauri -- build --bundles deb
  deb=$(find "$CARGO_TARGET_DIR/release/bundle/deb" -maxdepth 1 -name '*.deb' -print -quit)
  test -n "$deb"
fi
if [ "$deb" != "$out/depdek-ai-os-amd64.deb" ]; then
  cp "$deb" "$out/depdek-ai-os-amd64.deb"
fi
mkdir -p os/live/config/includes.chroot/usr/share/depdek
mkdir -p os/live/config/packages.chroot
install -D "$deb" os/live/config/packages.chroot/depdek-ai-os_amd64.deb
bash os/prepare-local-ai.sh "$work/os/live/config/includes.chroot" /live-cache/jiaho-ai

# Resolve Python dependencies before entering live-build's transient chroot DNS.
# The resulting wheels are installed without network access by the voice hook.
wheelhouse="$work/os/live/config/includes.chroot/usr/share/depdek/wheels"
mkdir -p "$wheelhouse"
python3 -m pip wheel --no-cache-dir --retries 4 --timeout 30 \
  --wheel-dir "$wheelhouse" 'vosk==0.3.45'

cd os/live
lb config \
  --mode debian \
  --distribution trixie \
  --architectures amd64 \
  --binary-images iso-hybrid \
  --cache true \
  --cache-stages "bootstrap" \
  --firmware-chroot false \
  --mirror-bootstrap https://deb.debian.org/debian \
  --mirror-chroot https://deb.debian.org/debian \
  --mirror-chroot-security https://security.debian.org/debian-security \
  --archive-areas "main contrib non-free-firmware" \
  --bootappend-live "boot=live components nocomponents=locales username=live hostname=jiaho quiet splash plymouth.ignore-serial-consoles console=ttyS0,115200n8 console=tty0" \
  --bootloaders "grub-pc grub-efi"
lb build

bash "$src/os/test-rootfs.sh" "$PWD/chroot"
bash "$src/os/test-vosk.sh" "$PWD/chroot" "$src/os/tests/fixtures/mandarin-mvp.wav"

iso=$(find . -maxdepth 1 -name '*.iso' -print -quit)
test -n "$iso"
# Checks above no longer need the unpacked rootfs. Reclaim staging before
# copying the ISO across Docker Desktop's host bind mount.
lb clean --chroot
cp "$iso" "$out/DepDek-AI-OS-amd64.iso.partial"
mv "$out/DepDek-AI-OS-amd64.iso.partial" "$out/DepDek-AI-OS-amd64.iso"
