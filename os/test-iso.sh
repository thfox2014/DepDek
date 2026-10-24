#!/bin/sh
set -eu
iso="$(realpath "$1")"
out=${DEPDEK_BOOT_OUTPUT_DIR:-/workspace/os/artifacts}
case "$out" in /workspace/os/artifacts|/workspace/os/artifacts/*) ;; *) echo "Invalid boot-test output directory" >&2; exit 1 ;; esac
mkdir -p "$out"
passed=0
log=/tmp/depdek-qemu-boot.log
qmp=/tmp/depdek-qemu-qmp.sock
pidfile=/tmp/depdek-qemu.pid
screen=/tmp/depdek-qemu-screen.ppm
splash=/tmp/depdek-qemu-splash.ppm
serial_socket=/tmp/depdek-qemu-serial.sock
rm -f "$log" "$qmp" "$pidfile" "$screen" "$splash" "$serial_socket"
cleanup() {
  [ ! -f "$log" ] || cp "$log" "$out/boot-serial.log"
  [ ! -f "$screen" ] || cp "$screen" "$out/boot-screen.ppm"
  [ ! -f "$splash" ] || cp "$splash" "$out/boot-splash.ppm"
  if [ "${DEPDEK_KEEP_VM:-0}" != 1 ] || [ "$passed" != 1 ]; then
    if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
  fi
}
trap cleanup EXIT

file "$iso" | tee /tmp/depdek-iso-file.txt
grep -q 'bootable' /tmp/depdek-iso-file.txt || { echo "ISO is not bootable" >&2; exit 1; }
qemu-system-x86_64 \
  -machine q35,accel=tcg -m 4096 -smp 2 \
  -cpu max,-avx,-avx2,-fma,-f16c,-bmi2 \
  -vga none -device virtio-vga,xres=1440,yres=900 \
  -boot d -cdrom "$iso" \
  -display vnc=127.0.0.1:1 \
  -chardev "socket,id=serial0,path=$serial_socket,server=on,wait=off,logfile=$log" -serial chardev:serial0 \
  -qmp "unix:$qmp,server=on,wait=off" \
  -pidfile "$pidfile" \
  -no-reboot -no-shutdown \
  -daemonize

# Read-only checks through the live serial console. KDE must be visible first,
# Jiaho must remain stopped until manually opened, and the guest display must
# expose a useful desktop resolution.
python3 - "$qmp" "$log" "$screen" "$serial_socket" <<'PY'
import json, os, re, shutil, socket, sys, time

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
ready_since = None

def usable_desktop_frame():
    command("screendump", {"filename": screen_path})
    with open(screen_path, "rb") as frame:
        if frame.readline().strip() != b"P6":
            return None
        dimensions = frame.readline()
        while dimensions.startswith(b"#"):
            dimensions = frame.readline()
        width, height = map(int, dimensions.split())
        if frame.readline().strip() != b"255":
            return None
        pixels = frame.read()
    if width < 1280 or height < 720 or len(pixels) < width * height * 3:
        return None
    visible = 0
    colors = set()
    for i in range(0, len(pixels) - 2, 3 * 13):
        r, g, b = pixels[i:i+3]
        visible += max(r, g, b) > 36
        if len(colors) < 128:
            colors.add((r // 16, g // 16, b // 16))
    if visible < width * height // 130 or len(colors) < 12:
        return None
    return width, height

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
    if now - last_check > 25 and "live@" in serial_log:
        console.sendall(b"pgrep -x plasmashell >/dev/null && echo KDE_DESKTOP_OK; if pgrep -x agent-workbench >/dev/null; then echo JIAHO_AUTOSTARTED; else echo JIAHO_READY_FOR_MANUAL_LAUNCH; fi; curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null && echo JIAHO_MODEL_OK\n")
        last_check = now
    # Match standalone output lines, not the echoed command text.
    kde_ready = re.search(r"\nkde_desktop_ok\s*\n", serial_log)
    manual_ready = re.search(r"\njiaho_ready_for_manual_launch\s*\n", serial_log)
    app_autostarted = re.search(r"\njiaho_autostarted\s*\n", serial_log)
    model_ready = re.search(r"\njiaho_model_ok\s*\n", serial_log)
    frame_size = usable_desktop_frame()
    if frame_size and not app_autostarted:
        shutil.copyfile(screen_path, "/tmp/depdek-qemu-splash.ppm")
        if kde_ready and manual_ready and model_ready:
            if ready_since is None:
                ready_since = now
            elif now - ready_since >= 10:
                print(f"KDE Plasma desktop verified at {frame_size[0]}x{frame_size[1]}; Jiaho remains available for manual launch; bundled model health verified with AVX/BMI2 disabled.")
                if os.environ.get("DEPDEK_KEEP_VM") != "1":
                    command("quit")
                sock.close()
                raise SystemExit(0)
    else:
        ready_since = None
    time.sleep(10)

if os.path.exists(screen_path):
    print(f"last screenshot saved to {screen_path}", file=sys.stderr)
try:
    print(open(serial_path, errors="replace").read()[-12000:], file=sys.stderr)
except FileNotFoundError:
    pass
raise SystemExit("KDE desktop did not become ready at a usable resolution with Jiaho stopped and the bundled model healthy within 900 seconds")
PY

passed=1
cp "$log" "$out/boot-serial.log"
cp "$screen" "$out/boot-screen.ppm"
