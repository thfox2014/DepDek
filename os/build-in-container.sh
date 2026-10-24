#!/usr/bin/env bash
set -euo pipefail
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export CARGO_TARGET_DIR=/cargo-cache

src=/workspace
work=/tmp/depdek-mvp
out="${DEPDEK_OS_OUTPUT_DIR:-$src/os/artifacts}"
case "$out" in "$src/os/artifacts"|"$src/os/artifacts/"*) ;; *) echo "OS output must stay under /workspace/os/artifacts" >&2; exit 1 ;; esac
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
if [ "${DEPDEK_APP_ONLY:-0}" = 1 ]; then
  sha256sum "$out/depdek-ai-os-amd64.deb"
  echo "Current AI-OS application package is ready; OS remaster is a separate explicit step."
  exit 0
fi
mkdir -p os/live/config/includes.chroot/usr/share/depdek
mkdir -p os/live/config/packages.chroot
install -D "$deb" os/live/config/packages.chroot/depdek-ai-os_amd64.deb
bash os/prepare-local-ai.sh "$work/os/live/config/includes.chroot" /live-cache/jiaho-ai

# Resolve Python dependencies before entering live-build's transient chroot DNS.
# The resulting wheels are installed without network access by the voice hook.
wheelhouse="$work/os/live/config/includes.chroot/usr/share/depdek/wheels"
mkdir -p "$wheelhouse"
/usr/bin/python3 -m pip wheel --no-cache-dir --retries 4 --timeout 30 \
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
  --apt-recommends false \
  --bootappend-live "boot=live components nocomponents=locales username=live hostname=jiaho quiet splash plymouth.ignore-serial-consoles console=ttyS0,115200n8 console=tty0" \
  --bootloaders "grub-pc grub-efi"
lb build

bash "$src/os/test-rootfs.sh" "$PWD/chroot"
bash "$src/os/test-vosk.sh" "$PWD/chroot" "$src/os/tests/fixtures/mandarin-mvp.wav"

iso=$(find . -maxdepth 1 -name '*.iso' -print -quit)
test -n "$iso"
file "$iso" | grep -q bootable
# Checks above no longer need the unpacked rootfs. Reclaim staging before
# replacing the existing image across Docker Desktop's host bind mount.
lb clean --chroot
output_iso="$out/DepDek-AI-OS-amd64.iso"
source_bytes=$(stat -c '%s' "$iso")
existing_bytes=0
if [ -f "$output_iso" ]; then existing_bytes=$(stat -c '%s' "$output_iso"); fi
available_kib=$(df -Pk "$out" | awk 'END { print $4 }')
[[ "$source_bytes" =~ ^[0-9]+$ && "$existing_bytes" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
reserve_bytes=$((512 * 1024 * 1024))
if [ "$((available_kib * 1024 + existing_bytes))" -lt "$((source_bytes + reserve_bytes))" ]; then
  printf 'Not replacing the existing ISO: need %s bytes plus 512 MiB reserve; available after replacement would be %s bytes.\n' \
    "$source_bytes" "$((available_kib * 1024 + existing_bytes))" >&2
  exit 1
fi
# The new ISO has already passed rootfs and voice checks. Replacing the named
# artifact in place avoids requiring two 1.7 GiB ISO files on small build disks.
cp "$iso" "$output_iso"
file "$output_iso" | grep -q bootable
sha256sum "$output_iso"
