#!/usr/bin/env bash
# Capture design-QA screenshots of the webdesk UI with headless Firefox.
#
# The console must be reachable from the same shell that runs Firefox (the
# sandbox gives every command its own network namespace), so the service, a
# small "slow endpoint" helper and the browser all start here.
#
#   bash webdesk/scripts/screenshot.sh [OUTPUT_DIR]
#
# Produces: desktop.png (系统性能监控桌面) and performance.png (性能监控应用).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-$repo_root/design-qa/webdesk-2026-09-27}"
binary="$repo_root/webdesk/target/release/depdek-webdesk"
dist="$repo_root/webdesk/web/dist"
run_dir="$repo_root/webdesk/.run-shot"
port="${DEPDEK_WEBDESK_SHOT_PORT:-8789}"

[[ -x "$binary" ]] || { echo "缺少 $binary，请先 cargo build --release"; exit 1; }
[[ -f "$dist/index.html" ]] || { echo "缺少前端构建：npm --prefix webdesk/web run build"; exit 1; }

mkdir -p "$out" "$run_dir"
cat > "$dist/__shot_desktop.html" <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;overflow:hidden">
  <iframe src="/" style="width:1440px;height:900px;border:0;display:block"></iframe>
  <!-- slow cross-origin image keeps the load event open until the SPA has rendered -->
  <img src="http://127.0.0.1:8899/__slow" alt="" style="position:fixed;left:-20px;top:-20px;width:1px;height:1px">
</body></html>
HTML

cat > "$dist/__shot_performance.html" <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;overflow:hidden">
  <iframe id="f" src="/" style="width:1440px;height:900px;border:0;display:block"></iframe>
  <img src="http://127.0.0.1:8899/__slow" alt="" style="position:fixed;left:-20px;top:-20px;width:1px;height:1px">
  <script>
    const frame = document.getElementById("f");
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      try {
        const items = [...frame.contentDocument.querySelectorAll(".launcher__item")];
        if (items.length > 1) { items[1].click(); clearInterval(timer); }   // 0 概览, 1 性能监控
        else if (tries > 120) clearInterval(timer);
      } catch (error) { clearInterval(timer); }
    }, 150);
  </script>
</body></html>
HTML

cat > "$run_dir/webdesk.toml" <<EOF
bind = "127.0.0.1:$port"
data_dir = "$run_dir"
web_root = "$dist"

[metrics]
interval_ms = 1000
history = 120
EOF

cleanup() { kill "$server_pid" "$slow_pid" 2>/dev/null || true; }
trap cleanup EXIT

"$binary" serve --config "$run_dir/webdesk.toml" --insecure-no-auth > "$run_dir/serve.log" 2>&1 &
server_pid=$!
python3 - "$repo_root" <<'PY' > "$run_dir/slow.log" 2>&1 &
import http.server, os, socketserver, sys, time
GIF = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/__slow"):
            time.sleep(7)
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(GIF)))
            self.end_headers()
            self.wfile.write(GIF)
            return
        self.send_error(404)
    def log_message(self, *args): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", 8899), H) as httpd:
    httpd.serve_forever()
PY
slow_pid=$!

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/api/health" && break
  sleep 0.25
done

profile="${DEPDEK_WEBDESK_FF_PROFILE:-$repo_root/.tools/ff-profile}"
export HOME="${HOME:-$repo_root/.tools/ff-home}"
export XDG_RUNTIME_DIR="$repo_root/.tools/run"
mkdir -p "$XDG_RUNTIME_DIR" "$out"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

shoot() {
  local page="$1" target="$2"
  timeout -k 5 90 firefox --headless --no-remote --profile "$profile" \
    --screenshot "$target" --window-size=1440,900 "http://127.0.0.1:$port/$page" >/dev/null 2>&1 || true
  [[ -s "$target" ]] && echo "  ✓ $target" || echo "  ✗ $target 未生成"
}

echo "== webdesk 截图（真实 /proc 数据，--insecure-no-auth）"
shoot "__shot_desktop.html" "$out/desktop.png"
shoot "__shot_performance.html" "$out/performance.png"
rm -f "$dist/__shot_desktop.html" "$dist/__shot_performance.html"
echo "输出目录：$out"
