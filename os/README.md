# DepDek AI-OS x86 MVP

This directory builds a bootable, installable Debian 13 (Trixie) amd64 image. The live session starts the DepDek Agent Shell; **Install DepDek AI-OS** opens Debian's Calamares installer. After installation, the shell starts when the installed user logs in. The installer owns disk selection and partition confirmation.

The image is built in an amd64 Debian container. On Apple Silicon, the build script uses a native ARM64 QEMU runner for the x86 boot test so the guest does not run nested inside an amd64-emulated builder. Build output is written to `os/artifacts/`:

- `DepDek-AI-OS-amd64.iso` — hybrid BIOS/UEFI installer image.
- `depdek-ai-os-amd64.deb` — the Tauri shell package used by the image.
- `boot-screen.ppm` — QEMU screenshot captured after the DepDek shell is visible.
- `boot-serial.log` — serial output from the matching boot test.
- `iteration-14-boot.log`, `iteration-15-validation.log`, and `iteration-16-validation.log` — boot, regression, and build-log rotation records.

Run `bash os/build-mvp.sh`. It requires Docker Desktop to be running and enough free disk for a Linux builder, Rust/Node dependencies, the live root filesystem, and the ISO. Each run automatically numbers and saves separate build and boot-test logs in `os/artifacts/`. The build script does not remove Docker images or caches; live-build stores its Linux filesystem cache in the named Docker volume `depdek-ai-os-live-build-cache`. Remove that volume, `depdek-ai-os-builder:trixie`, or `os/artifacts/` yourself after saving artifacts if you need the disk space back.

Third-party notices are in [`THIRD_PARTY.md`](THIRD_PARTY.md).

Speech recognition uses the Apache-2.0 `vosk-model-small-cn-0.22` model and a Python Vosk runtime installed in the live image. Audio is capped at 30 seconds, stays in memory, and is not saved. The UI requires the user to review the transcript before sending it to an AI provider. The first-run endpoint defaults to local Ollama (`127.0.0.1:11434`); users may explicitly configure another OpenAI-compatible endpoint. Existing app settings store provider credentials in the user's application settings file, so this MVP does not claim encrypted credential storage.

The smoke suite verifies the Debian package architecture and contents, hybrid ISO metadata, live-session boot through to the visible shell in QEMU, Home initialization, shell autostart registration, and offline Vosk model loading. The QEMU test waits for the graphical shell rather than stopping at the earlier LightDM startup message. BIOS boot is verified; physical x86 and USB boot, UEFI boot, and a complete install to a target disk remain follow-up checks.
