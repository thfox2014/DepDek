#!/usr/bin/env bash
# Prepare a root-free build sysroot for the Tauri desktop bundle.
#
# This machine (DepDek AI-OS) has the webkit/gtk *runtime* libraries but not
# the -dev packages, no Rust toolchain and no usable root (the DSH sandbox
# mounts / read-only and drops setuid). So instead of `apt install` we
# download only the missing -dev delta into .tools/debs, unpack it into
# .tools/sysroot and expose it through PKG_CONFIG_* in scripts/local-build-env.sh.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools="$repo_root/.tools"
debs="$tools/debs"
sysroot="$tools/sysroot"

pkgs=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libssl-dev
  pkg-config
)

mkdir -p "$debs" "$sysroot"

echo "== downloading missing -dev delta into $debs"
apt-get install --download-only --no-install-recommends -y \
  -o "Dir::Cache::archives=$debs" \
  -o Debug::NoLocking=1 \
  -o "APT::Sandbox::User=$(id -un)" \
  "${pkgs[@]}"

echo "== unpacking $(ls "$debs"/*.deb | wc -l) packages into $sysroot"
for deb in "$debs"/*.deb; do
  dpkg-deb -x "$deb" "$sysroot"
done

# -dev packages ship `libfoo.so -> libfoo.so.N` symlinks, but the real
# libfoo.so.N lives in the runtime package that is already installed under
# /usr/lib. Re-point every broken symlink at the system library so the linker
# can resolve -lfoo through the sysroot.
echo "== repairing broken .so symlinks against /usr/lib"
fixed=0
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  case "$target" in /*) continue ;; esac
  for dir in /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu /usr/lib; do
    if [ -e "$dir/$target" ]; then
      ln -sfn "$dir/$target" "$link"
      fixed=$((fixed + 1))
      break
    fi
  done
done < <(find "$sysroot" -xtype l -print0)
echo "   repaired $fixed symlinks"

leftover="$(find "$sysroot" -xtype l | wc -l)"
echo "== $leftover unresolved symlinks remain (ok if unused by the build)"

# cargo's pkg-config crate does not honour PKG_CONFIG_SYSROOT_DIR, so bake the
# sysroot prefix straight into every .pc file instead. The first sed strips any
# prefix from a previous run so this step is idempotent.
echo "== rewriting /usr paths in .pc files to $sysroot"
count=0
while IFS= read -r -d '' pc; do
  sed -i "s|$sysroot||g; s|/usr|$sysroot/usr|g" "$pc"
  count=$((count + 1))
done < <(find "$sysroot" -name '*.pc' -print0)
echo "   rewrote $count .pc files"

echo "== sysroot ready: $(du -sh "$sysroot" | cut -f1)"
