import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = new URL("../os/live/config/includes.chroot/", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const shell = (path) => spawnSync("/bin/sh", ["-n", new URL(path, root).pathname], { encoding: "utf8" });
function harness(run) {
  const directory = mkdtempSync(join(tmpdir(), "jiaho-startup-test-"));
  const events = join(directory, "events"), count = join(directory, "count");
  const write = (path, content) => { const file = join(directory, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, content, { mode: 0o755 }); return file; };
  try {
    for (const path of ["usr/bin", "usr/local/bin", "usr/lib/jiaho", "etc/lightdm/lightdm.conf.d", "runtime", "bin"]) mkdirSync(join(directory, path), { recursive: true });
    // Run real checked-in scripts against a disposable, explicitly translated
    // OS fixture. No real getent inventory, LightDM config, desktop or app runs.
    for (const path of ["usr/local/bin/jiaho", "usr/lib/jiaho/start-session", "usr/lib/jiaho/select-session-user"]) {
      const text = source(path).replaceAll("/usr/", `${directory}/usr/`).replaceAll("/etc/lightdm/", `${directory}/etc/lightdm/`);
      write(path, text);
    }
    write("bin/id", '#!/bin/sh\nprintf "%s\\n" "${TEST_UID:-1000}"\n');
    write("bin/getent", '#!/bin/sh\nprintf "%s\\n" "$TEST_PASSWD"\n');
    write("bin/install", '#!/bin/sh\nwhile [ "$#" -gt 1 ]; do shift; done\nmkdir -p "$1"\n');
    write("bin/sleep", '#!/bin/sh\nprintf "delay:%s\\n" "$1" >> "$TEST_EVENTS"\n');
    write("usr/bin/xsetroot", '#!/bin/sh\nprintf "background\\n" >> "$TEST_EVENTS"\n');
    write("usr/bin/startx", '#!/bin/sh\nprintf "startx:%s\\n" "$*" >> "$TEST_EVENTS"\n');
    write("usr/bin/dbus-run-session", '#!/bin/sh\nprintf "dbus\\n" >> "$TEST_EVENTS"\nshift\nexport DBUS_SESSION_BUS_ADDRESS=unix:path=synthetic\nexec "$@"\n');
    const helper = '#!/bin/sh\nprintf "helper:%s\\n" "${0##*/}" >> "$TEST_EVENTS"\ntrap \'exit 0\' TERM HUP INT\nwhile :; do /bin/sleep 0.05; done\n';
    write("usr/bin/xfwm4", helper); write("usr/bin/xfsettingsd", helper);
    // Unit fixture, not an implementation/claim of Linux flock semantics.
    write("usr/bin/flock", '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --nonblock|--close) shift ;; --conflict-exit-code) shift 2 ;; *) break ;; esac; done\nshift\nexec "$@"\n');
    write("usr/bin/agent-workbench", `#!/bin/sh
count=0; [ ! -f "$TEST_COUNT" ] || count=$(head -1 "$TEST_COUNT")
count=$((count + 1)); printf '%s\\n' "$count" > "$TEST_COUNT"
printf 'app:%s:%s:%s\\n' "$count" "${"${JIAHO_OS_SESSION:-unset}"}" "$*" >> "$TEST_EVENTS"
case "${"${TEST_MODE:-normal}"}" in crash) exit 17 ;; recover) [ "$count" -ge 3 ] || exit 17 ;; esac
exit 0
`);
    write("usr/bin/startplasma-x11", '#!/bin/sh\nprintf "maintenance:%s:%s:%s\\n" "$JIAHO_MAINTENANCE_DESKTOP" "${JIAHO_OS_SESSION:-unset}" "$XDG_CURRENT_DESKTOP" >> "$TEST_EVENTS"\n');
    const env = { ...process.env, PATH: `${directory}/bin:/usr/bin:/bin`, DISPLAY: ":synthetic", XDG_RUNTIME_DIR: join(directory, "runtime"), DBUS_SESSION_BUS_ADDRESS: "unix:path=synthetic", TEST_EVENTS: events, TEST_COUNT: count, TEST_UID: "1000", TEST_PASSWD: "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000::/home/user:/bin/bash" };
    delete env.JIAHO_OS_SESSION; delete env.JIAHO_MAINTENANCE_DESKTOP;
    return run({ directory, env, execute: (path, extra = {}, args = []) => spawnSync("/bin/sh", [join(directory, path), ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 8000 }), events: () => existsSync(events) ? readFileSync(events, "utf8") : "" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("boot scripts parse, KDE is the default, and Jiaho has a manual desktop launcher", () => {
  for (const path of ["usr/local/bin/jiaho", "usr/lib/jiaho/start-session", "usr/lib/jiaho/select-session-user", "usr/share/depdek/depdek-shell"]) assert.equal(shell(path).status, 0, path);
  assert.match(source("usr/share/xsessions/jiaho.desktop"), /^Exec=\/usr\/lib\/jiaho\/start-session$/m);
  const hook = readFileSync(new URL("../os/live/config/hooks/normal/0500-depdek-voice.hook.chroot", import.meta.url), "utf8");
  assert.match(hook, /systemctl enable lightdm.service jiaho-session-user.service/);
  assert.match(hook, /im-config -n fcitx5/);
  const launcher = source("usr/share/applications/jiaho.desktop");
  assert.match(launcher, /^Name=家合 AI-OS$/m); assert.match(launcher, /^Exec=\/usr\/local\/bin\/jiaho$/m);
  assert.match(launcher, /^Icon=\/usr\/share\/plymouth\/themes\/jiaho\/jiaho-logo\.png$/m);
  assert.ok(!existsSync(new URL("etc/xdg/autostart/depdek-ai-os.desktop", root)), "KDE must remain visible at login");
  assert.match(hook, /install -D -m 0755 \/usr\/share\/applications\/jiaho\.desktop \/etc\/skel\/Desktop\/jiaho\.desktop/);
  const packages = readFileSync(new URL("../os/live/config/package-lists/depdek.list.chroot", import.meta.url), "utf8");
  for (const name of ["plasma-desktop", "plasma-workspace", "kwin-x11", "fcitx5", "fcitx5-chinese-addons", "fcitx5-frontend-gtk3", "fcitx5-frontend-qt6", "im-config"]) assert.match(packages, new RegExp(`^${name}$`, "m"));
  assert.match(source("etc/skel/.config/fcitx5/profile"), /^DefaultIM=pinyin$/m);
  assert.match(source("etc/systemd/system/jiaho-session-user.service"), /After=.*live-config.service/);
  const session = source("usr/lib/jiaho/start-session");
  assert.ok(!session.includes("curl ")); assert.ok(!session.includes("network-online.target"));
});
test("boot selects an ordinary OS account and Plasma X11, not root or a business identity", () => harness(({ execute, directory }) => {
  assert.equal(execute("usr/lib/jiaho/select-session-user").status, 0);
  const config = readFileSync(join(directory, "etc/lightdm/lightdm.conf.d/90-jiaho.conf"), "utf8");
  assert.match(config, /autologin-user=user\n/); assert.match(config, /autologin-session=plasmax11/); assert.match(config, /user-session=plasmax11/);
  assert.ok(!config.includes("password"));
}));
test("manual Jiaho launch from KDE does not force the full-screen OS presentation mode", () => harness(({ execute, events }) => {
  const result = execute("usr/local/bin/jiaho");
  assert.equal(result.status, 0, result.stderr);
  assert.match(events(), /app:1:unset:/);
}));
test("missing and malformed eligible users never generate a usable autologin configuration", () => {
  harness(({ execute, directory }) => {
    assert.equal(execute("usr/lib/jiaho/select-session-user", { TEST_PASSWD: "root:x:0:0::/root:/bin/bash\nnobody:x:65534:65534::/:/usr/sbin/nologin" }).status, 0);
    assert.ok(!existsSync(join(directory, "etc/lightdm/lightdm.conf.d/90-jiaho.conf")));
  });
  harness(({ execute, directory }) => {
    assert.notEqual(execute("usr/lib/jiaho/select-session-user", { TEST_PASSWD: "bad;name:x:1000:1000::/home/user:/bin/bash" }).status, 0);
    assert.ok(!existsSync(join(directory, "etc/lightdm/lightdm.conf.d/90-jiaho.conf")));
  });
});
test("the optional Jiaho recovery session falls back to KDE; normal launches remain manual", () => harness(({ execute, events }) => {
  const result = execute("usr/lib/jiaho/start-session"); assert.equal(result.status, 0, result.stderr);
  assert.equal(events().match(/app:/g)?.length, 1); assert.match(events(), /app:1:1:/);
  assert.match(events(), /maintenance::unset:KDE/);
  assert.equal(execute("usr/local/bin/jiaho").status, 0);
  assert.equal(events().match(/app:/g)?.length, 2);
}));
test("crashes are retried only three times with bounded backoff then recover to Plasma", () => harness(({ execute, events }) => {
  const result = execute("usr/lib/jiaho/start-session", { TEST_MODE: "crash" }); assert.equal(result.status, 0, result.stderr);
  assert.equal(events().match(/app:/g)?.length, 3); assert.match(events(), /delay:2\n/); assert.match(events(), /delay:4\n/);
  assert.match(events(), /maintenance::unset:KDE/);
}));
test("a later successful launch stops retries and a missing bus is established exactly once", () => harness(({ execute, events }) => {
  const result = execute("usr/lib/jiaho/start-session", { TEST_MODE: "recover", DBUS_SESSION_BUS_ADDRESS: "" }); assert.equal(result.status, 0, result.stderr);
  assert.equal(events().match(/dbus\n/g)?.length, 1); assert.equal(events().match(/app:/g)?.length, 3);
  assert.match(events(), /maintenance::unset:KDE/);
}));
test("root is refused; a TTY starts the same session and a missing user runtime never runs the app", () => {
  harness(({ execute, events }) => {
    assert.notEqual(execute("usr/local/bin/jiaho", { TEST_UID: "0" }).status, 0);
    assert.notEqual(execute("usr/lib/jiaho/start-session", { TEST_UID: "0" }).status, 0); assert.equal(events(), "");
    assert.equal(execute("usr/local/bin/jiaho", { DISPLAY: "" }).status, 0); assert.match(events(), /startx:.*start-session -- -keeptty/);
    assert.notEqual(execute("usr/local/bin/jiaho", { XDG_RUNTIME_DIR: "" }).status, 0); assert.ok(!events().includes("app:"));
  });
});
test("full screen is Linux OS presentation only; login stays a separate core gate", () => {
  const app = readFileSync(new URL("../src-tauri/src/app.rs", import.meta.url), "utf8");
  const block = app.slice(app.indexOf('// Presentation only:'), app.indexOf('let obsidian =', app.indexOf('// Presentation only:')));
  assert.match(block, /cfg!\(target_os = "linux"\)/); assert.match(block, /VITE_DEPDEK_OS/); assert.match(block, /JIAHO_OS_SESSION/); assert.match(block, /window.set_fullscreen\(true\)/);
  assert.ok(!block.includes("login(")); assert.ok(!block.includes("password"));
  assert.match(app, /vault.enable_ai_os_login/);
});
