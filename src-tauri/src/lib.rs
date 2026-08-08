//! DepDek Rust core.
//!
//! `vault`, `audit`, `settings` and `rpc` are plain Rust and testable
//! without a display server. The Tauri desktop shell (`app`) is gated
//! behind the default `tauri-app` feature; build the core alone with
//! `cargo test --no-default-features`.

pub mod audit;
pub mod rpc;
pub mod settings;
pub mod vault;

#[cfg(feature = "tauri-app")]
mod app;

#[cfg(feature = "tauri-app")]
pub fn run() {
    app::run();
}

#[cfg(not(feature = "tauri-app"))]
pub fn run() {
    eprintln!(
        "agent-workbench: built without the `tauri-app` feature (library/test build only)"
    );
}
