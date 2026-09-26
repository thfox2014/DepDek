#!/usr/bin/env node
// DepDek version management.
//
// `VERSION` at the repository root is the single source of truth. Every package
// manifest is derived from it, so a release is one command:
//
//   npm run version:check                 # verify every manifest matches VERSION
//   npm run version:sync                  # force every manifest back to VERSION
//   npm run version:bump -- patch         # 0.2.0 -> 0.2.1 (+ CHANGELOG entry)
//   npm run version:bump -- minor         # 0.2.1 -> 0.3.0
//   npm run version:bump -- major         # 0.3.0 -> 1.0.0
//   npm run version:bump -- 1.2.0         # set an explicit version
//   npm run version:bump -- patch --note "修复邮件索引" --note "新增导出"
//
// The deb/msi/dmg bundles take their version from src-tauri/tauri.conf.json and
// src-tauri/Cargo.toml, so keeping those in lockstep is what makes the OS image
// build and `dpkg -i` upgrades report the same version as the UI.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = join(repoRoot, "VERSION");
const changelogFile = join(repoRoot, "CHANGELOG.md");

const paths = {
  rootPackage: join(repoRoot, "package.json"),
  sidecarPackage: join(repoRoot, "sidecar", "package.json"),
  tauriConf: join(repoRoot, "src-tauri", "tauri.conf.json"),
  cargoToml: join(repoRoot, "src-tauri", "Cargo.toml"),
  cargoLock: join(repoRoot, "src-tauri", "Cargo.lock"),
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const CARGO_PACKAGE_NAME = "agent-workbench";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readText(path) {
  if (!existsSync(path)) fail(`缺少文件：${path}`);
  return readFileSync(path, "utf8");
}

function writeText(path, content, dryRun) {
  if (dryRun) {
    console.log(`  · 将更新 ${path.slice(repoRoot.length + 1)}`);
    return;
  }
  writeFileSync(path, content);
  console.log(`  ✓ ${path.slice(repoRoot.length + 1)}`);
}

function readVersion() {
  const raw = readText(versionFile).trim();
  if (!SEMVER.test(raw)) fail(`VERSION 内容不是合法 semver：${JSON.stringify(raw)}`);
  return raw;
}

/** Current version declared in each manifest, for both sync and check. */
function collectManifests() {
  const rootPackage = JSON.parse(readText(paths.rootPackage));
  const sidecarPackage = JSON.parse(readText(paths.sidecarPackage));
  const tauriConf = JSON.parse(readText(paths.tauriConf));
  const cargoToml = readText(paths.cargoToml);
  const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!cargoMatch) fail("src-tauri/Cargo.toml 中找不到 [package] version");
  const cargoLock = readText(paths.cargoLock);
  const lockMatch = cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${CARGO_PACKAGE_NAME}"\\nversion = "([^"]+)"`));
  if (!lockMatch) fail(`src-tauri/Cargo.lock 中找不到 ${CARGO_PACKAGE_NAME} 的版本条目`);

  return [
    { label: "package.json", current: rootPackage.version },
    { label: "sidecar/package.json", current: sidecarPackage.version },
    { label: "src-tauri/tauri.conf.json", current: tauriConf.version },
    { label: "src-tauri/Cargo.toml", current: cargoMatch[1] },
    { label: "src-tauri/Cargo.lock", current: lockMatch[1] },
  ];
}

/**
 * Replace only the top-level version value. Re-serialising the JSON would
 * reformat unrelated lines (tauri.conf.json keeps an inline icon array), and a
 * version bump should stay a one-line diff.
 */
function writeJsonVersion(path, version, dryRun) {
  const text = readText(path);
  JSON.parse(text);
  const pattern = /("version"\s*:\s*)"[^"]*"/;
  if (!pattern.test(text)) fail(`${path} 中找不到 version 字段`);
  const next = text.replace(pattern, `$1"${version}"`);
  JSON.parse(next);
  writeText(path, next, dryRun);
}

function writeVersion(version, dryRun) {
  writeText(versionFile, `${version}\n`, dryRun);
  writeJsonVersion(paths.rootPackage, version, dryRun);
  writeJsonVersion(paths.sidecarPackage, version, dryRun);
  writeJsonVersion(paths.tauriConf, version, dryRun);

  const cargoToml = readText(paths.cargoToml);
  writeText(paths.cargoToml, cargoToml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`), dryRun);

  const cargoLock = readText(paths.cargoLock);
  writeText(
    paths.cargoLock,
    cargoLock.replace(
      new RegExp(`(\\[\\[package\\]\\]\\nname = "${CARGO_PACKAGE_NAME}"\\nversion = )"[^"]+"`),
      `$1"${version}"`,
    ),
    dryRun,
  );
}

function commandCheck() {
  const version = readVersion();
  const mismatched = collectManifests().filter((entry) => entry.current !== version);
  if (mismatched.length) {
    console.error(`✗ 版本不一致，VERSION = ${version}`);
    for (const entry of mismatched) console.error(`   ${entry.label}: ${entry.current}`);
    console.error("  修复：npm run version:sync");
    process.exit(1);
  }
  console.log(`✓ 版本一致：${version}（VERSION 与 4 个 manifest + Cargo.lock）`);
}

function commandSync() {
  const version = readVersion();
  console.log(`同步到 ${version}`);
  writeVersion(version, false);
  commandCheck();
}

function nextVersion(current, level) {
  if (SEMVER.test(level)) return level;
  const [, major, minor, patch] = current.match(SEMVER);
  if (level === "major") return `${Number(major) + 1}.0.0`;
  if (level === "minor") return `${major}.${Number(minor) + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${Number(patch) + 1}`;
  fail(`无法识别的版本级别：${level}（可用 patch | minor | major | X.Y.Z）`);
}

function prependChangelog(version, notes, dryRun) {
  // Local date (toISOString would stamp yesterday for UTC+8 evening releases).
  const date = new Date().toLocaleDateString("sv-SE");
  const bullets = notes.length ? notes.map((note) => `- ${note}`) : ["- 待补充。"];
  const entry = `## [${version}] - ${date}\n\n${bullets.join("\n")}\n`;
  const existing = existsSync(changelogFile)
    ? readText(changelogFile)
    : "# 更新日志\n\n本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，版本号由 `VERSION` 与 `npm run version:bump` 统一管理。\n";

  const header = "# 更新日志\n\n本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，版本号由 `VERSION` 与 `npm run version:bump` 统一管理。\n";
  const body = existing.startsWith(header) ? existing.slice(header.length) : existing;
  writeText(changelogFile, `${header}\n${entry}${body.replace(/^\n+/, "\n")}`, dryRun);
}

function commandBump(args) {
  const level = args.find((arg) => !arg.startsWith("--"));
  if (!level) fail("用法：npm run version:bump -- <patch|minor|major|X.Y.Z> [--note \"说明\"]");

  const notes = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--note") {
      const value = args[index + 1];
      if (!value) fail("--note 需要一个参数");
      notes.push(value);
      index++;
    }
  }

  const current = readVersion();
  const next = nextVersion(current, level);
  if (next === current) fail(`新版本与当前版本相同：${current}`);

  console.log(`版本 ${current} → ${next}`);
  writeVersion(next, false);
  prependChangelog(next, notes, false);
  commandCheck();
  console.log("\n下一步：提交改动并打标签，例如 git commit -am \"release: v" + next + "\" && git tag v" + next);
}

const [command = "check", ...rest] = process.argv.slice(2);
if (command === "check") commandCheck();
else if (command === "sync") commandSync();
else if (command === "bump") commandBump(rest);
else fail(`未知命令：${command}（可用 check | sync | bump）`);
