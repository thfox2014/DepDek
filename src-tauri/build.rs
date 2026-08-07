fn main() {
    // Only invoke the Tauri build script when the desktop app feature is on.
    // Feature cfgs are passed to build scripts by Cargo, so this stays
    // inert for `cargo test --no-default-features`.
    #[cfg(feature = "tauri-app")]
    tauri_build::build();
}
