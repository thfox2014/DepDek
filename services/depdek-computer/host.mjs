// Trusted fixed host broker. Agent receives no Docker socket or CLI tool.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
function opt(k) {
  const i = args.indexOf(k);
  if (i < 0) throw Error("CONFIG");
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const docker = opt("--docker"),
  image = opt("--image"),
  dockerHost = opt("--docker-host"),
  hosts = opt("--hosts").split(",");
if (
  args.length ||
  !docker.startsWith("/") ||
  !/^sha256:[a-f0-9]{64}$/.test(image) ||
  !dockerHost.startsWith("unix:///")
)
  throw Error("CONFIG");
async function run(args, input, limit = 1100000) {
  return new Promise((ok, no) => {
    const p = spawn(docker, ["--host", dockerHost, ...args], {
      env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let chunks = [],
      size = 0;
    const timer = setTimeout(() => {
      p.kill();
      no(Error("COMPUTER_TIMEOUT"));
    }, 27000);
    p.on("error", () => {
      clearTimeout(timer);
      no(Error("DOCKER_UNAVAILABLE"));
    });
    p.stderr.on("data", (b) => b.fill(0));
    p.stdout.on("data", (b) => {
      size += b.length;
      if (size > limit) {
        p.kill();
        no(Error("OUTPUT_LIMIT"));
      } else chunks.push(b);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? ok(Buffer.concat(chunks).toString())
        : no(Error("DOCKER_UNAVAILABLE"));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}
let raw = "";
for await (const b of process.stdin) {
  raw += b;
  if (Buffer.byteLength(raw) > 22000) throw Error("INPUT_LIMIT");
}
try {
  const { owner, action } = JSON.parse(raw);
  raw = "";
  if (typeof owner !== "string" || owner.length > 256) throw Error("INPUT");
  const name =
    "depdek-computer-" +
    createHash("sha256").update(owner).digest("hex").slice(0, 24);
  let found = null;
  try {
    found = JSON.parse(await run(["inspect", name], undefined, 50000))[0];
  } catch {}
  if (action.kind === "stop") {
    if (found) {
      check(found);
      await run(["stop", "--time", "2", name]);
    }
    console.log(
      JSON.stringify({
        running: false,
        revision: 0,
        elements: [],
        request: null,
        screenshot: null,
      }),
    );
    process.exit();
  }
  if (!found && action.kind === "status") {
    console.log(
      JSON.stringify({
        running: false,
        revision: 0,
        elements: [],
        request: null,
        screenshot: null,
      }),
    );
    process.exit();
  }
  if (found) check(found);
  if (!found) {
    await run([
      "run",
      "--detach",
      "--rm",
      "--init",
      "--name",
      name,
      "--label",
      "depdek.computer=1",
      "--label",
      `depdek.owner=${name}`,
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=1g",
      "--cpus=2",
      "--pids-limit=192",
      "--shm-size=256m",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      "--env",
      `DEPDEK_COMPUTER_HOSTS=${hosts.join(",")}`,
      image,
    ]);
  }
  // Retry only read-only readiness. Never retry an action with unknown outcome.
  if(!found)for (let i = 0; i < 30; i++) {
    try {
      const ready=JSON.parse(await run(['exec','--interactive',name,'node','/opt/depdek-computer/client.mjs'],JSON.stringify({kind:'status'})));
      if(ready.error)throw Error('COMPUTER_UNAVAILABLE');
      break;
    } catch (e) {
      if (i === 29) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const result=JSON.parse(await run(['exec','--interactive',name,'node','/opt/depdek-computer/client.mjs'],JSON.stringify(action)));
  if (result.error) throw Error(result.error);
  result.container = name;
  console.log(JSON.stringify(result));
  function check(c) {
    if (
      c.Image !== image ||
      c.Config.Labels?.["depdek.owner"] !== name ||
      c.Config.Labels?.["depdek.computer"] !== "1" ||
      c.Config.User !== "1000:1000" ||
      !c.HostConfig.ReadonlyRootfs ||
      c.HostConfig.Privileged ||
      c.HostConfig.NetworkMode === "host" ||
      c.HostConfig.IpcMode === "host" ||
      c.Mounts.some((m) => m.Type === "bind") ||
      Object.keys(c.HostConfig.PortBindings || {}).length
    )
      throw Error("COMPUTER_CONFIG_CHANGED");
  }
} catch (e) {
  console.log(
    JSON.stringify({
      error: [
        "PAGE_CHANGED",
        "HOST_NOT_ALLOWED",
        "INPUT_NOT_REQUESTED",
        "INPUT_INVALID",
        "COMPUTER_CONFIG_CHANGED",
        "DOCKER_UNAVAILABLE",
        "COMPUTER_TIMEOUT",
      ].includes(e.message)
        ? e.message
        : "COMPUTER_UNAVAILABLE",
    }),
  );
  process.exitCode = 2;
}
