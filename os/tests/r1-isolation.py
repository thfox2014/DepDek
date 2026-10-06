"""Disposable Linux acceptance. Docker engine is local; no NAS/user Home mounts.

Usage: python3 os/tests/r1-isolation.py --volume BUILD_VOLUME --image BUILDER
Build volume must contain Linux target/debug binaries. It is never deleted here.
Only this run's named containers and synthetic fixture directories are touched.
"""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path

PASSWORD = "SyntheticLinuxBusiness2026!"
PHRASE = "SyntheticLinuxSecretStore2026!"
KEY = "synthetic-linux-provider-key"


def command(args, value=None, check=True):
    result = subprocess.run(args, input=None if value is None else
                            (value if isinstance(value, str) else json.dumps(value)),
                            capture_output=True, text=True, timeout=60)
    if check and result.returncode:
        # Fixed diagnostic: never print stdin/requests/credential responses.
        raise RuntimeError("Linux acceptance subprocess failed")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--volume", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--platform", default="linux/amd64")
    args = parser.parse_args()
    endpoint = command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.strip()
    if not os.environ.get("DOCKER_CONTEXT"):
        endpoint = os.environ.get("DOCKER_HOST", endpoint)
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Acceptance requires a local Unix Docker endpoint")
    command(["docker", "image", "inspect", args.image])
    suffix = str(time.time_ns())
    core = "depdek-r1-core-" + suffix
    worker = "depdek-r1-worker-" + suffix
    report = []
    repo = Path(__file__).resolve().parents[2]
    volume = args.volume
    fixture = "fixture-" + suffix
    binary_mount = ["--mount", f"type=volume,src={volume},dst=/opt/depdek,volume-subpath=target/debug,readonly"]
    image = ["--platform", args.platform, args.image]

    def root_fixture(script, value):
        command(["docker", "run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL",
                 "--cap-add", "CHOWN", "--security-opt", "no-new-privileges",
                 "--mount", f"type=volume,src={volume},dst=/output"] +
                image + ["python3", "-c", script, "/output/" + fixture], value)

    def cli(operation, value):
        result = command(["docker", "exec", "-i", "--user", "1001:1002", core,
                          "/opt/depdek/depdek", "--socket", "/fixture/control/core.sock"] + operation, value, False)
        reply = json.loads(result.stdout)
        assert KEY not in result.stdout and KEY not in result.stderr
        return reply

    def start_core():
        command(["docker", "run", "-d", "--name", core, "--user", "1001:1002",
                 "--network", "none", "--read-only", "--cap-drop", "ALL",
                 "--security-opt", "no-new-privileges", "--pids-limit", "64",
                 "--memory", "768m", "--cpus", "2", "--mount",
                 f"type=volume,src={volume},dst=/fixture,volume-subpath={fixture}",
                 "--mount", f"type=bind,src={repo / 'os/tests/r1-local-provider.py'},dst=/test/provider.py,readonly"] +
                binary_mount + image + ["sh", "-c",
                "python3 /test/provider.py & exec /opt/depdek/depdekd serve --config /fixture/control.json"])
        for _ in range(100):
            ready = command(["docker", "exec", "--user", "1001:1002", core,
                             "/opt/depdek/depdek", "--socket", "/fixture/control/core.sock", "health"], check=False)
            if ready.returncode == 0:
                return
            time.sleep(0.1)
        raise RuntimeError("Synthetic daemon did not become ready")

    def worker_rpc(method, params, uid="1002:1002"):
        code = """import json,socket,sys
s=socket.socket(socket.AF_UNIX);s.settimeout(10);s.connect('/fixture/worker-runtime/worker.sock')
data=json.load(sys.stdin);raw=b''
try:s.sendall((json.dumps(data)+'\\n').encode())
except (BrokenPipeError,ConnectionResetError):
 print(json.dumps({'transport_denied':True}));sys.exit(0)
while not raw.endswith(b'\\n'):
 try:p=s.recv(4096)
 except ConnectionResetError:
  raw=b'{"transport_denied":true}\\n';break
 if not p:break
 raw+=p
sys.stdout.buffer.write(raw)
"""
        result = command(["docker", "exec", "-i", "--user", uid, worker,
                          "python3", "-c", code],
                         {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        assert KEY not in result.stdout and KEY not in result.stderr
        return json.loads(result.stdout)

    try:
        phc = command(["docker", "run", "--rm", "-i", "--network", "none",
                       "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"] +
                      binary_mount + image + ["/opt/depdek/depdek", "auth", "hash-password", "--stdin"],
                      {"password": PASSWORD}).stdout.strip()
        config = {"workspace_id": "w1", "root": "/fixture/home", "read_paths": ["documents"],
                  "socket": "/fixture/control/core.sock", "secret_dir": "/fixture/secrets",
                  "access_users": [{"principal_id": "alice", "password_hash": phc,
                                    "read_paths": ["documents/alice"]}],
                  "worker_transport": {"socket": "/fixture/worker-runtime/worker.sock", "uid": 1002, "gid": 1002}}
        root_fixture("""import json,os,sys
p=sys.argv[1];os.mkdir(p,0o700)
for rel,mode in [('home',0o700),('home/documents',0o700),('home/documents/alice',0o700),('home/documents/bob',0o700),('control',0o700),('secrets',0o700),('worker-runtime',0o710)]:os.mkdir(p+'/'+rel,mode)
for rel,content in [('home/documents/alice/a.md','合成凭证'),('home/documents/bob/b.md','private-bob')]:
 with open(p+'/'+rel,'w') as f:f.write(content)
config=json.load(sys.stdin)
with open(p+'/control.json','w') as f:json.dump(config,f)
os.chmod(p+'/control.json',0o600)
for root,dirs,files in os.walk(p,topdown=False):
 for file in files:os.chown(root+'/'+file,1001,1002)
 os.chown(root,1001,1002)
""", config)
        start_core()
        init = cli(["credentials", "init", "--workspace", "w1", "--stdin"],
                   {"operation_id": "init", "passphrase": PHRASE})
        assert "result" in init
        stored = cli(["credentials", "put", "--workspace", "w1", "--stdin"],
                     {"operation_id": "key", "binding": {"kind": "provider", "account_id": "local-test", "field": "api_key"},
                      "expected_revision": 0, "secret": KEY})["result"]["data"]["credential"]
        command(["docker", "stop", "-t", "10", core])
        command(["docker", "rm", core])
        config["provider_profiles"] = [{"id": "local-test", "name": "Synthetic local Provider",
            "base_url": "http://127.0.0.1:18080/v1", "protocol": "openai-completions", "model": "synthetic-linux-model",
            "profile_revision": 1, "credential_ref": stored["credential_ref"], "credential_revision": 1,
            "credential_binding": stored["binding"]}]
        config["local_model_profiles"] = ["local-test"]
        # Config is owned by core uid: modify only via that uid, while daemon stopped.
        command(["docker", "run", "--rm", "-i", "--user", "1001:1002", "--network", "none",
                 "--read-only", "--cap-drop", "ALL", "--mount",
                 f"type=volume,src={volume},dst=/fixture,volume-subpath={fixture}"] + image +
                ["python3", "-c", "import json,sys;v=json.load(sys.stdin);f=open('/fixture/control.json','w');json.dump(v,f);f.close()"], config)
        start_core()
        cli(["credentials", "unlock", "--workspace", "w1", "--stdin"], {"passphrase": PHRASE})
        session = cli(["auth", "login", "--stdin"], {"username": "alice", "password": PASSWORD})["result"]["data"]
        command(["docker", "run", "-d", "--name", worker, "--user", "1002:1002",
                 "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                 "--pids-limit", "32", "--memory", "128m", "--cpus", "1", "--mount",
                 f"type=volume,src={volume},dst=/fixture/worker-runtime,volume-subpath={fixture}/worker-runtime,readonly"] +
                binary_mount + image + ["sleep", "600"])
        inspected = json.loads(command(["docker", "inspect", worker]).stdout)[0]
        assert inspected["Config"]["User"] == "1002:1002"
        assert inspected["HostConfig"]["NetworkMode"] == "none" and inspected["HostConfig"]["ReadonlyRootfs"]
        assert inspected["HostConfig"]["CapDrop"] == ["ALL"] and not inspected["HostConfig"]["Privileged"]
        assert "no-new-privileges" in inspected["HostConfig"]["SecurityOpt"]
        assert all(not m["RW"] for m in inspected["Mounts"])
        report.append("Worker 独立 uid、只读挂载/rootfs、cap-drop/no-new-privileges、无网络")
        command(["docker", "exec", worker, "python3", "-c",
                 "import os,socket;assert os.geteuid()==1002;status=open('/proc/self/status').read();assert 'CapEff:\t0000000000000000' in status;assert 'NoNewPrivs:\t1' in status;assert not os.path.exists('/fixture/home');assert not os.path.exists('/fixture/secrets');assert not os.path.exists('/fixture/control');s=socket.socket();s.settimeout(1);assert s.connect_ex(('127.0.0.1',18080))!=0"])
        report.append("Worker 看不到原件/凭据/owner socket，不能直接连接 Provider")
        denied = worker_rpc("v2/credentials.list", {"workspace_id": "w1", "input": {}})
        assert denied["error"]["data"]["error"]["code"] == "FORBIDDEN"
        wrong_uid = worker_rpc("v2/worker.invoke", {}, "1003:1002")
        assert wrong_uid.get("transport_denied") or wrong_uid["error"]["code"] == -32000
        report.append("实际 Unix peer 错 uid、owner 凭据 RPC 被拒绝")
        auth = {"session_token": session["session_token"], "csrf_token": session["csrf_token"]}
        lease = cli(["worker", "issue", "--workspace", "w1", "--stdin"],
                    {**auth, "scope": {"paths": ["documents/alice"], "commands": ["file.read"]}})["result"]["data"]
        params = {"workspace_id": "w1", "lease_token": lease["lease_token"], "run_id": lease["run_id"],
                  "call_id": "one", "command": "file.read", "command_version": "1.0", "input": {"path": "documents/alice/a.md"}}
        actual = command(["docker", "exec", "-i", worker, "/opt/depdek/depdek-worker", "--socket",
                          "/fixture/worker-runtime/worker.sock", "--server-uid", "1001"], json.dumps(params)+"\n")
        assert json.loads(actual.stdout)["result"]["data"]["result"]["content"] == "合成凭证"
        params["call_id"] = "other"; params["input"]["path"] = "documents/bob/b.md"
        assert worker_rpc("v2/worker.invoke", params)["error"]["data"]["error"]["code"] == "NOT_FOUND"
        report.append("独立进程文件查询成功；跨用户目录拒绝")
        model_lease = cli(["model", "issue", "--workspace", "w1", "--stdin"],
                          {**auth, "provider_id": "local-test", "profile_revision": 1,
                           "prompt": "仅分析合成空调维修材料", "max_tokens": 128, "ttl_seconds": 60})["result"]["data"]
        model = {"workspace_id": "w1", "lease_token": model_lease["lease_token"], "run_id": model_lease["run_id"], "call_id": "model-one"}
        actual = command(["docker", "exec", "-i", worker, "/opt/depdek/depdek-worker", "--model", "--socket",
                          "/fixture/worker-runtime/worker.sock", "--server-uid", "1001"], json.dumps(model)+"\n")
        answer = json.loads(actual.stdout)["result"]["data"]["result"]
        assert answer["text"] == "合成资料已核对：forms@support.example.invalid"
        assert answer["usage"] == {"input_tokens": 12, "output_tokens": 8}
        assert KEY not in actual.stdout
        assert worker_rpc("v2/model.invoke", model)["error"]["data"]["error"]["code"] == "CONFLICT"
        report.append("受控出口实际连接合成 Provider，usage/Unicode 完整；授权消费后重放拒绝")
        cli(["auth", "logout", "--stdin"], auth)
        params["call_id"] = "after-logout"
        assert worker_rpc("v2/worker.invoke", params)["error"]["data"]["error"]["code"] == "SESSION_EXPIRED"
        logs = command(["docker", "logs", core]).stdout + command(["docker", "logs", core]).stderr
        for secret in [KEY, PHRASE, PASSWORD, session["session_token"], session["csrf_token"], lease["lease_token"], model_lease["lease_token"]]:
            assert secret not in logs
        command(["docker", "exec", "-i", "--user", "1001:1002", core, "python3", "-c",
                 "import json,sys;secrets=json.load(sys.stdin);a=open('/fixture/home/.vault-audit.jsonl').read()+open('/fixture/secrets/.secret-audit.jsonl').read();assert not any(s in a for s in secrets)"],
                [KEY, PHRASE, PASSWORD, session["session_token"], session["csrf_token"], lease["lease_token"], model_lease["lease_token"], "仅分析合成空调维修材料"])
        report.append("注销即时撤销；日志/审计不含秘密、授权 bearer 或输入正文")
        print(json.dumps({"passed": len(report), "platform": args.platform, "checks": report,
                          "real_model": False, "nas_changed": False, "volume": volume,
                          "retained_synthetic_fixture": fixture}, ensure_ascii=False, indent=2))
    finally:
        for name in [worker, core]:
            command(["docker", "rm", "-f", name], check=False)


if __name__ == "__main__":
    main()
