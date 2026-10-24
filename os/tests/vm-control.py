#!/usr/bin/env python3
"""Local QA for the disposable QEMU guest, not a Jiaho/Agent capability.

Read one JSON request from stdin. Uses only the test container's Unix sockets;
never exposes a host shell, HTTP API, model key or the host's desktop.
"""
import json
import re
import socket
import sys
import time

request = json.load(sys.stdin)
action = request["action"]
if action == "guest":
    line = request["line"]
    if len(line) > 4096 or "\n" in line or "\r" in line:
        raise SystemExit("one bounded guest command required")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(1)
    connection.connect("/tmp/depdek-qemu-serial.sock")
    marker = "__JIAHO_GUEST_COMMAND_FINISHED__"
    connection.sendall(("\n(" + line + "); echo " + marker + "\n").encode())
    data = b""
    deadline = time.monotonic() + request.get("timeout", 30)
    while time.monotonic() < deadline:
        try:
            data += connection.recv(65536)
        except socket.timeout:
            continue
        if re.search(rb"\n" + marker.encode() + rb"\r?\n", data):
            break
    else:
        raise SystemExit("guest command timed out")
    sys.stdout.write(data.decode(errors="replace"))
    connection.close()
    raise SystemExit(0)

connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.settimeout(30)
connection.connect("/tmp/depdek-qemu-qmp.sock")
stream = connection.makefile("rwb", buffering=0)
json.loads(stream.readline())
serial = 0


def command(name, arguments=None):
    global serial
    serial += 1
    payload = {"execute": name, "id": serial}
    if arguments is not None:
        payload["arguments"] = arguments
    stream.write((json.dumps(payload) + "\r\n").encode())
    while True:
        response = json.loads(stream.readline())
        if response.get("id") == serial:
            if "error" in response:
                raise RuntimeError(response["error"])
            return response.get("return")


command("qmp_capabilities")
if action == "status":
    print(json.dumps(command("query-status")))
elif action == "screenshot":
    print(json.dumps(command("screendump", {"filename": request["path"]})))
elif action == "click":
    x, y, width, height = (request[field] for field in ["x", "y", "width", "height"])
    if not (0 <= x < width and 0 <= y < height):
        raise SystemExit("click outside observed screenshot")
    command("input-send-event", {"events": [
        {"type": "abs", "data": {"axis": "x", "value": round(x * 32767 / (width - 1))}},
        {"type": "abs", "data": {"axis": "y", "value": round(y * 32767 / (height - 1))}},
        {"type": "btn", "data": {"button": "left", "down": True}},
    ]})
    command("input-send-event", {"events": [{"type": "btn", "data": {"button": "left", "down": False}}]})
elif action == "key":
    if not re.fullmatch(r"[a-z0-9_-]+", request["key"]):
        raise SystemExit("invalid key combination")
    print(command("send-key", {"keys": [{"type": "qcode", "data": key} for key in request["key"].split("-")], "hold-time": 30}))
elif action == "type":
    text = request["text"]
    if len(text) > 512:
        raise SystemExit("bounded UI test text required")
    punctuation = {" ": "spc", "\n": "ret", ".": "dot", "-": "minus", "_": "shift-minus", "!": "shift-1", "@": "shift-2", "/": "slash", ":": "shift-semicolon"}
    keys = []
    for char in text:
        if "a" <= char <= "z" or "0" <= char <= "9":
            keys.append(char)
        elif "A" <= char <= "Z":
            keys.append("shift-" + char.lower())
        elif char in punctuation:
            keys.append(punctuation[char])
        else:
            raise SystemExit("unsupported test key")
    for key in keys:
        command("send-key", {"keys": [{"type": "qcode", "data": part} for part in key.split("-")], "hold-time": 30})
        time.sleep(0.1)
else:
    raise SystemExit("unsupported local VM test action")
connection.close()
