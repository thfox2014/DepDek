#!/usr/bin/env bash
# End-to-end smoke test for depdek-webdesk.
#
# Starts the release binary on a loopback port with a throwaway config, then
# checks the real HTTP surface with curl: health, auth guard, login, session
# cookie, metrics, processes, apps, audit tail, CSRF-protected logout and the
# embedded SPA. Run it with `bash webdesk/scripts/e2e.sh`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
webdesk="$repo_root/webdesk"
binary="$webdesk/target/release/depdek-webdesk"
run_dir="${DEPDEK_WEBDESK_E2E_DIR:-$webdesk/.run}"
port="${DEPDEK_WEBDESK_E2E_PORT:-8788}"
password="e2e-password-123"
base="http://127.0.0.1:$port"

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ✓ %-46s %s\n' "$label" "$actual"
  else
    printf '  ✗ %-46s 期望 %s，实际 %s\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

[[ -x "$binary" ]] || { echo "缺少 $binary，请先 cargo build --release"; exit 1; }
pkill -f "depdek-webdesk serve --config $run_dir" 2>/dev/null || true
rm -rf "$run_dir"
mkdir -p "$run_dir"

hash="$(DEPDEK_WEBDESK_PASSWORD_HASH= "$binary" hash-password "$password" | sed -n "s/^password_hash = '\(.*\)'$/\1/p")"
[[ -n "$hash" ]] || { echo "无法生成密码哈希"; exit 1; }

cat > "$run_dir/webdesk.toml" <<EOF
bind = "127.0.0.1:$port"
data_dir = "$run_dir"

[auth]
password_hash = '$hash'
max_failures = 3

[metrics]
interval_ms = 1000
history = 30
EOF

DEPDEK_WEBDESK_AGENT_SOCKET="$run_dir/agent.sock" DEPDEK_WEBDESK_AGENT_CONFIG_SOCKET="$run_dir/agent-config.sock" "$binary" serve --config "$run_dir/webdesk.toml" > "$run_dir/serve.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "$base/api/health"; then break; fi
  sleep 0.25
done

echo "== 公开接口"
check "GET /api/health" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health")"
check "GET /api/session (未登录)" "false" "$(curl -s "$base/api/session" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["authenticated"]).lower())')"
check "GET /api/system/summary 无 Cookie" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/system/summary")"
check "未知 API 返回 JSON 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/nope")"
check "GET / 返回 SPA" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$base/")"
check "SPA 含 root 容器" "yes" "$(curl -s "$base/" | grep -q 'id="root"' && echo yes || echo no)"

echo "== 登录与凭据"
check "错误密码被拒绝" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/login" -H 'content-type: application/json' -d '{"password":"wrong-password"}')"
login_body="$(curl -s -D "$run_dir/login-headers.txt" -c "$run_dir/cookies.txt" -X POST "$base/api/login" -H 'content-type: application/json' -d "{\"password\":\"$password\"}")"
check "正确密码登录成功" "true" "$(echo "$login_body" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["authenticated"]).lower())')"
csrf="$(echo "$login_body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')"
check "Set-Cookie 为 HttpOnly" "yes" "$(grep -qi 'HttpOnly' "$run_dir/login-headers.txt" && echo yes || echo no)"
check "Set-Cookie 为 SameSite=Strict" "yes" "$(grep -qi 'SameSite=Strict' "$run_dir/login-headers.txt" && echo yes || echo no)"
check "会话 Cookie 已写入 cookie jar" "yes" "$(grep -q 'depdek_webdesk_session' "$run_dir/cookies.txt" && echo yes || echo no)"

echo "== 受保护接口"
summary="$(curl -s -b "$run_dir/cookies.txt" "$base/api/system/summary")"
check "summary.host.cores_logical >= 1" "yes" "$(echo "$summary" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["host"]["cores_logical"] >= 1 else "no")')"
check "summary.memory.total_bytes > 0" "yes" "$(echo "$summary" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["memory"]["total_bytes"] > 0 else "no")')"
check "summary.apps 非空" "yes" "$(echo "$summary" | python3 -c 'import json,sys; print("yes" if len(json.load(sys.stdin)["apps"]) > 0 else "no")')"
check "Agent status 要求登录" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/agent/status")"
check "Agent Provider 列表要求登录" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/agent/providers")"
agent_status="$(curl -s -b "$run_dir/cookies.txt" "$base/api/agent/status")"
check "Agent status 无服务时安全降级" "false" "$(echo "$agent_status" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["available"]).lower())')"
check "Agent 对话校验 CSRF" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H 'content-type: application/json' -d '{"message":"hello","history":[]}' "$base/api/agent/chat")"
check "Provider 保存校验 CSRF" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H 'content-type: application/json' -d '{"id":"test","name":"test","base_url":"https://example.com","protocol":"openai-completions","model":"test","api_key":"do-not-log-this"}' "$base/api/agent/providers")"
provider_save_status="$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H "x-depdek-csrf: $csrf" -H 'content-type: application/json' -d '{"id":"test","name":"test","base_url":"https://example.com","protocol":"openai-completions","model":"test","api_key":"do-not-log-this"}' "$base/api/agent/providers")"
check "Provider 保存只转发给安全 broker" "503" "$provider_save_status"
check "切换 Provider 校验 CSRF" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H 'content-type: application/json' -d '{"id":"test"}' "$base/api/agent/providers/activate")"
provider_activate_status="$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H "x-depdek-csrf: $csrf" -H 'content-type: application/json' -d '{"id":"test"}' "$base/api/agent/providers/activate")"
check "切换 Provider 只转发给安全 broker" "503" "$provider_activate_status"
provider_audit="$(curl -s -b "$run_dir/cookies.txt" "$base/api/audit?limit=50")"
check "审计记录 Provider 保存尝试" "yes" "$(echo "$provider_audit" | grep -q 'agent.provider.save' && echo yes || echo no)"
check "审计记录 Provider 切换尝试" "yes" "$(echo "$provider_audit" | grep -q 'agent.provider.activate' && echo yes || echo no)"
check "审计不保存 Provider API Key" "yes" "$(echo "$provider_audit" | grep -q 'do-not-log-this' && echo no || echo yes)"
check "Agent 对话未连接执行器返回 503" "503" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H "x-depdek-csrf: $csrf" -H 'content-type: application/json' -d '{"message":"hello","history":[]}' "$base/api/agent/chat")"
check "series 有采样点" "yes" "$(curl -s -b "$run_dir/cookies.txt" "$base/api/system/series?window=5" | python3 -c 'import json,sys; print("yes" if len(json.load(sys.stdin)["samples"]) > 0 else "no")')"
check "processes 按内存排序" "yes" "$(curl -s -b "$run_dir/cookies.txt" "$base/api/processes?sort=mem&limit=5" | python3 -c '
import json,sys
rows=[p["mem_bytes"] for p in json.load(sys.stdin)["processes"]]
print("yes" if rows == sorted(rows, reverse=True) and len(rows) > 0 else "no")')"
check "apps 含每应用聚合" "yes" "$(curl -s -b "$run_dir/cookies.txt" "$base/api/apps?limit=3" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("yes" if d["apps"] and d["apps"][0]["processes"] >= 1 else "no")')"
check "audit 含登录记录" "yes" "$(curl -s -b "$run_dir/cookies.txt" "$base/api/audit?limit=20" | grep -q 'login.success' && echo yes || echo no)"
agent_audit="$(curl -s -b "$run_dir/cookies.txt" "$base/api/audit?limit=50")"
check "审计记录 Agent 尝试" "yes" "$(echo "$agent_audit" | grep -q 'agent.chat' && echo yes || echo no)"
check "审计不保存 Agent 对话正文" "yes" "$(echo "$agent_audit" | grep -q 'hello' && echo no || echo yes)"

echo "== CSRF 与登出"
check "登出缺少 CSRF 令牌被拒" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -X POST "$base/api/logout")"
check "带 CSRF 令牌登出成功" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" -H "x-depdek-csrf: $csrf" -X POST "$base/api/logout")"
check "登出后会话失效" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$run_dir/cookies.txt" "$base/api/system/summary")"

echo "== 登录限流"
for _ in 1 2 3; do curl -s -o /dev/null -X POST "$base/api/login" -H 'content-type: application/json' -d '{"password":"wrong-password"}'; done
check "连续失败后返回 429" "429" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/login" -H 'content-type: application/json' -d "{\"password\":\"$password\"}")"

echo "== 审计日志"
check "审计文件存在" "yes" "$([[ -s "$run_dir/webdesk-audit.jsonl" ]] && echo yes || echo no)"
check "审计含失败登录" "yes" "$(grep -q 'login.failure' "$run_dir/webdesk-audit.jsonl" && echo yes || echo no)"
check "审计含登出" "yes" "$(grep -q 'session.logout' "$run_dir/webdesk-audit.jsonl" && echo yes || echo no)"

echo
if [[ "$failures" -eq 0 ]]; then
  echo "全部通过。服务日志：$run_dir/serve.log"
else
  echo "$failures 项失败，见上方 ✗ 标记与 $run_dir/serve.log"
  exit 1
fi
