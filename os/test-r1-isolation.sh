#!/usr/bin/env bash
set -euo pipefail
# Explicit local disposable acceptance; never mounts Home, runtime secrets or NAS.
task_repo="$(cd "$(dirname "$0")/.." && pwd)"
task_image="${R1_BUILDER_IMAGE:-depdek-ai-os-builder:trixie}"
task_platform="${R1_BUILDER_PLATFORM:-linux/amd64}"
task_registry="${CARGO_HOME:-${HOME}/.cargo}/registry"
task_volume="depdek-r1-isolation-$(date +%Y%m%d%H%M%S)-$$"
task_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
if test -z "${DOCKER_CONTEXT:-}"; then task_endpoint="${DOCKER_HOST:-$task_endpoint}"; fi
case "$task_endpoint" in unix://*) ;; *) printf 'Local Unix Docker endpoint required\n' >&2; exit 2;; esac
docker info --format '{{.OSType}}' | rg -q '^linux$'
docker image inspect "$task_image" >/dev/null
test -d "$task_registry"
docker volume create "$task_volume" >/dev/null
printf 'Disposable acceptance volume (retained): %s\n' "$task_volume"
# Read-only repository/registry. Copy build cache into this run's separate volume.
docker run --rm --platform "$task_platform" --network none \
  --mount "type=bind,src=$task_repo,dst=/src,readonly" \
  --mount "type=bind,src=$task_registry,dst=/registry,readonly" \
  --mount "type=volume,src=$task_volume,dst=/output" "$task_image" sh -c \
  'mkdir -p /output/cargo/registry; cp -a /registry/. /output/cargo/registry/; CARGO_HOME=/output/cargo CARGO_TARGET_DIR=/output/target CARGO_BUILD_JOBS=4 cargo build --manifest-path /src/services/depdekd/Cargo.toml --locked --offline'
python3 "$task_repo/os/tests/r1-isolation.py" --volume "$task_volume" --image "$task_image" --platform "$task_platform"
# Named temporary containers are cleaned by the test. No volume/data deletion.
