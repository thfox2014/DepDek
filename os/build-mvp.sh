#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifacts="$repo_root/os/artifacts"
mkdir -p "$artifacts"

iteration=0
for existing_log in "$artifacts"/iteration-*-*.log; do
  [[ -e "$existing_log" ]] || continue
  existing_name="${existing_log##*/}"
  existing_number="${existing_name#iteration-}"
  existing_number="${existing_number%%-*}"
  if [[ "$existing_number" =~ ^[0-9]+$ ]] && (( 10#$existing_number > iteration )); then
    iteration="$((10#$existing_number))"
  fi
done
iteration=$((iteration + 1))
build_log="$artifacts/iteration-$iteration-build.log"
boot_log="$artifacts/iteration-$iteration-boot.log"

printf 'DepDek AI-OS build iteration %s\n' "$iteration" | tee "$build_log"
docker build --platform linux/amd64 -f "$repo_root/os/Dockerfile.amd64" -t depdek-ai-os-builder:trixie "$repo_root" 2>&1 | tee -a "$build_log"
docker volume create depdek-ai-os-live-build-cache >/dev/null
docker run --rm --privileged --platform linux/amd64 \
  -e VITE_DEPDEK_OS=1 \
  -e DEPDEK_PREBUILT_DEB="${DEPDEK_PREBUILT_DEB:-}" \
  -v "$repo_root:/workspace" \
  -v depdek-ai-os-live-build-cache:/live-cache \
  -w /workspace \
  depdek-ai-os-builder:trixie \
  bash os/build-in-container.sh 2>&1 | tee -a "$build_log"

case "$(uname -m)" in
  arm64|aarch64)
    qemu_platform=linux/arm64
    qemu_image=depdek-ai-os-qemu:trixie-arm64
    docker build --platform "$qemu_platform" \
      -f "$repo_root/os/Dockerfile.qemu-arm64" \
      -t "$qemu_image" "$repo_root" 2>&1 | tee "$boot_log"
    ;;
  *)
    qemu_platform=linux/amd64
    qemu_image=depdek-ai-os-builder:trixie
    ;;
esac

docker run --rm --platform "$qemu_platform" \
  -v "$repo_root:/workspace" \
  -w /workspace \
  "$qemu_image" \
  sh os/test-iso.sh /workspace/os/artifacts/DepDek-AI-OS-amd64.iso \
  2>&1 | tee -a "$boot_log"
