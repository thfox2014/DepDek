//! Build script: inject the repository version and guarantee that the embedded
//! SPA folder exists.
//!
//! `VERSION` at the repository root is the single source of truth
//! (scripts/version.mjs keeps every manifest in sync). It is baked into the
//! binary as `DEPDEK_VERSION` and surfaced through `/api/health`.
//!
//! rust-embed needs `web/dist` at compile time, but a fresh clone has no
//! frontend build yet, so a placeholder page is written when the folder is
//! missing. `npm --prefix webdesk/web run build` replaces it with the real SPA.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>DepDek webdesk</title>
    <style>
      body { margin: 0; display: grid; place-items: center; height: 100vh;
             background: #101319; color: #e6eaf2; font: 14px/1.7 system-ui, sans-serif; }
      code { color: #c6ef6c; }
    </style>
  </head>
  <body>
    <div>
      <h1>DepDek webdesk</h1>
      <p>前端尚未构建。运行 <code>npm --prefix webdesk/web install &amp;&amp; npm --prefix webdesk/web run build</code> 后重新编译本 crate。</p>
      <p>API 已可用：<code>GET /api/health</code></p>
    </div>
  </body>
</html>
"#;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let version_file = manifest_dir.join("../VERSION");
    println!("cargo:rerun-if-changed={}", version_file.display());

    let version = fs::read_to_string(&version_file)
        .map(|raw| raw.trim().to_string())
        .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into()));
    println!("cargo:rustc-env=DEPDEK_VERSION={version}");

    let dist = manifest_dir.join("web/dist");
    let index = dist.join("index.html");
    println!("cargo:rerun-if-changed={}", dist.display());
    if !index.exists() {
        fs::create_dir_all(&dist).expect("create web/dist");
        fs::write(&index, PLACEHOLDER).expect("write web/dist/index.html placeholder");
        println!(
            "cargo:warning=webdesk/web/dist 为空，已写入占位首页（运行 webdesk/web 的前端构建可替换）"
        );
    }
    ensure_watch(&dist);
}

/// `cargo:rerun-if-changed` on a directory only tracks its mtime on some
/// platforms; register the known top-level entries as well.
fn ensure_watch(dist: &Path) {
    if let Ok(entries) = fs::read_dir(dist) {
        for entry in entries.flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }
}
