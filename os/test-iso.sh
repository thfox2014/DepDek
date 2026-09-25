#!/bin/sh
set -eu
iso="$(realpath "$1")"
out=/workspace/os/artifacts
log=/tmp/depdek-qemu-boot.log
qmp=/tmp/depdek-qemu-qmp.sock
pidfile=/tmp/depdek-qemu.pid
screen=/tmp/depdek-qemu-screen.ppm
rm -f "$log" "$qmp" "$pidfile" "$screen"
cleanup() {
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
}
trap cleanup EXIT

file "$iso" | tee /tmp/depdek-iso-file.txt
grep -q 'bootable' /tmp/depdek-iso-file.txt || { echo "ISO is not bootable" >&2; exit 1; }
qemu-system-x86_64 \
  -machine q35,accel=tcg -m 4096 -smp 2 \
  -boot d -cdrom "$iso" \
  -display vnc=127.0.0.1:1 -serial "file:$log" \
  -qmp "unix:$qmp,server=on,wait=off" \
  -pidfile "$pidfile" \
  -no-reboot -no-shutdown \
  -daemonize

# LightDM's systemd start marker precedes Xfce and the Tauri shell by several
# minutes under ARM-hosted x86 TCG. Keep sampling until the branded shell is
# actually on screen instead of treating a login service marker as success.
python3 - "$qmp" "$log" "$screen" <<'PY'
import json, os, re, socket, sys, time

qmp_path, serial_path, screen_path = sys.argv[1:]
deadline = time.monotonic() + 900
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
lightdm_seen = False
checks = 0
while time.monotonic() < deadline:
    try:
        serial_log = open(serial_path, errors="replace").read().lower()
    except FileNotFoundError:
        serial_log = ""
    if not lightdm_seen and re.search(r"lightdm|depdek tty|login:", serial_log):
        lightdm_seen = True
        print("QEMU reached the display-manager startup stage; waiting for DepDek.", flush=True)
    if lightdm_seen:
        checks += 1
        command("screendump", {"filename": screen_path})
        data = open(screen_path, "rb").read()
        header = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", data)
        if header:
            width, height = map(int, header.groups())
            pixels = data[header.end():]
            if len(pixels) == width * height * 3:
                # The DepDek shell uses a charcoal workspace with lime accents.
                # The black boot screen and cursor have fewer than 100 such pixels.
                lime = sum(
                    g > 40 and g > r * 1.05 and g > b * 1.05
                    for r, g, b in zip(pixels[0::3], pixels[1::3], pixels[2::3])
                )
                if lime >= 1000:
                    print(f"DepDek shell visible: {width}x{height}; {lime} lime-accent pixels")
                    command("quit")
                    sock.close()
                    raise SystemExit(0)
        if checks % 6 == 0:
            print(f"Still waiting for the graphical shell ({checks} screen checks).", flush=True)
    time.sleep(10)

if os.path.exists(screen_path):
    print(f"last screenshot saved to {screen_path}", file=sys.stderr)
try:
    print(open(serial_path, errors="replace").read()[-12000:], file=sys.stderr)
except FileNotFoundError:
    pass
raise SystemExit("DepDek shell did not appear within 900 seconds")
PY

cp "$log" "$out/boot-serial.log"
cp "$screen" "$out/boot-screen.ppm"
