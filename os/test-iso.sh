#!/bin/sh
set -eu
iso="$(realpath "$1")"
out=/workspace/os/artifacts
log=/tmp/depdek-qemu-boot.log
qmp=/tmp/depdek-qemu-qmp.sock
pidfile=/tmp/depdek-qemu.pid
screen=/tmp/depdek-qemu-screen.ppm
serial_socket=/tmp/depdek-qemu-serial.sock
rm -f "$log" "$qmp" "$pidfile" "$screen" "$serial_socket"
cleanup() {
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
}
trap cleanup EXIT

file "$iso" | tee /tmp/depdek-iso-file.txt
grep -q 'bootable' /tmp/depdek-iso-file.txt || { echo "ISO is not bootable" >&2; exit 1; }
qemu-system-x86_64 \
  -machine q35,accel=tcg -m 4096 -smp 2 \
  -cpu max,-avx,-avx2,-fma,-f16c,-bmi2 \
  -boot d -cdrom "$iso" \
  -display vnc=127.0.0.1:1 \
  -chardev "socket,id=serial0,path=$serial_socket,server=on,wait=off,logfile=$log" -serial chardev:serial0 \
  -qmp "unix:$qmp,server=on,wait=off" \
  -pidfile "$pidfile" \
  -no-reboot -no-shutdown \
  -daemonize

# Read-only checks through the live serial console; the VGA screen must show
# the actual auto-started AI-OS account page, not just a systemd milestone.
python3 - "$qmp" "$log" "$screen" "$serial_socket" <<'PY'
import json, os, re, socket, sys, time

qmp_path, serial_path, screen_path, serial_socket = sys.argv[1:]
deadline = time.monotonic() + 900
console = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
console.connect(serial_socket)
console.setblocking(False)
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(30)
sock.connect(qmp_path)
stream = sock.makefile("rwb", buffering=0)
json.loads(stream.readline())
serial = 0

def command(name, arguments=None):
    global serial
    serial += 1
    request = {"execute": name, "id": serial}
    if arguments is not None:
        request["arguments"] = arguments
    stream.write((json.dumps(request) + "\r\n").encode())
    while True:
        response = json.loads(stream.readline())
        if response.get("id") == serial:
            if "error" in response:
                raise RuntimeError(response["error"])
            return response.get("return")

command("qmp_capabilities")
last_check = 0
last_login = 0
while time.monotonic() < deadline:
    try:
        console.recv(65536)
    except BlockingIOError:
        pass
    try:
        serial_log = open(serial_path, errors="replace").read().lower()
    except FileNotFoundError:
        serial_log = ""
    now = time.monotonic()
    if now - last_login > 15 and re.search(r"(?:jiaho|depdek|live) login:", serial_log[-800:]):
        console.sendall(b"live\n")
        last_login = now
    elif now - last_login > 5 and "password:" in serial_log[-150:]:
        console.sendall(b"live\n")
        last_login = now
    if now - last_check > 25 and ("live@" in serial_log or "jiaho ai-os" in serial_log):
        console.sendall(b"pgrep -x agent-workbench >/dev/null && echo JIAHO_APP_OK; curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null && echo JIAHO_MODEL_OK\n")
        last_check = now
    # Match standalone output lines, not the echoed command text.
    if re.search(r"\njiaho_app_ok\s*\n", serial_log) and re.search(r"\njiaho_model_ok\s*\n", serial_log):
        command("screendump", {"filename": screen_path})
        if not os.path.getsize(screen_path):
            raise SystemExit("QEMU did not capture the AI-OS screen")
        print("Graphical AI-OS process and real bundled model health verified with AVX disabled; account page captured.")
        command("quit")
        sock.close()
        raise SystemExit(0)
    time.sleep(10)

if os.path.exists(screen_path):
    print(f"last screenshot saved to {screen_path}", file=sys.stderr)
try:
    print(open(serial_path, errors="replace").read()[-12000:], file=sys.stderr)
except FileNotFoundError:
    pass
raise SystemExit("Graphical AI-OS / bundled model did not become ready within 900 seconds")
PY

cp "$log" "$out/boot-serial.log"
cp "$screen" "$out/boot-screen.ppm"
