#!/usr/bin/env bash
set -euo pipefail
root="$(realpath "$1")"
fixture="$(realpath "$2")"
python=/opt/depdek/venv/bin/python
script="$(find "$root/usr/lib" -type f -name transcribe.py -print -quit)"
if [ -z "$script" ]; then
  echo "packaged DepDek voice script was not found in the live rootfs" >&2
  exit 1
fi
model="$(dirname "$script")/vosk-model-small-cn-0.22"
script_rel="/${script#"$root/"}"
model_rel="/${model#"$root/"}"
result="$(unshare --net chroot "$root" "$python" "$script_rel" "$model_rel" < "$fixture")"
normalized="$(printf '%s' "$result" | python3 -c 'import re,sys; print(re.sub(r"[^\w]", "", sys.stdin.read()))')"
printf 'Vosk Mandarin result: %s\n' "$result"
case "$normalized" in
  *你好*今天*测试*) ;;
  *) echo "Mandarin speech fixture did not match expected phrase" >&2; exit 1 ;;
esac
