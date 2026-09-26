#!/usr/bin/env bash
# Source this to build DepDek on this machine without root:
#
#   source scripts/local-build-env.sh
#   npm run tauri -- build --bundles deb
#
# The DSH sandbox mounts / read-only, drops setuid (so sudo cannot work) and no
# Rust toolchain is installed system-wide, so the toolchain lives in .tools/
# and the webkit/gtk headers come from scripts/prepare-local-sysroot.sh.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export DEPDEK_REPO="$repo_root"
export DEPDEK_SYSROOT="$repo_root/.tools/sysroot"
export RUSTUP_HOME="$repo_root/.tools/rustup"
export CARGO_HOME="$repo_root/.tools/cargo"

export PATH="$CARGO_HOME/bin:$DEPDEK_SYSROOT/usr/bin:$PATH"

# prepare-sidecar.mjs bundles `process.execPath` as the sidecar runtime. The
# shipped package used Node 24.21.0, so prefer a matching runtime from
# .tools/node24/bin (the system node here is 22.x) to keep the bundle in parity.
if [ -x "$repo_root/.tools/node24/bin/node" ]; then
  export PATH="$repo_root/.tools/node24/bin:$PATH"
fi

# The .pc files were rewritten to point inside the sysroot, so the sysroot
# variable must stay unset (setting it would double-prefix every path). The
# system pkg-config dirs are appended so that dev packages which are already
# installed system-wide (zlib1g-dev, shared-mime-info, ...) still resolve.
unset PKG_CONFIG_SYSROOT_DIR
unset PKG_CONFIG_LIBDIR
export PKG_CONFIG_PATH="$DEPDEK_SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$DEPDEK_SYSROOT/usr/share/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig"

export LIBRARY_PATH="$DEPDEK_SYSROOT/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
export LD_LIBRARY_PATH="$DEPDEK_SYSROOT/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# The sandbox keeps $HOME read-only; keep npm and cargo caches in the workspace.
export npm_config_cache="$repo_root/.tools/npm-cache"
mkdir -p "$npm_config_cache"

echo "DepDek build env: cargo=$(command -v cargo || echo MISSING) sysroot=$DEPDEK_SYSROOT"
