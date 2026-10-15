# DepDek AI-OS x86 MVP

This directory builds a bootable, installable Debian 13 (Trixie) amd64 image. The current Jiaho edition shows the approved orange/green brand in GRUB and Plymouth, opens the ordinary local graphical session, and starts the AI-OS account page automatically. First boot creates the user's own native account; there is no universal application password. The first successful sign-in grants 1,000 setup credits once. The local setup AI costs 10 credits per reply and helps the user choose initial preferences before entering the workbench. **Install DepDek AI-OS** opens Debian's Calamares installer. `depdek-shell` and a text recovery boot entry remain available.

The bundled default AI is Qwen2.5-0.5B-Instruct Q4_K_M, served by a pinned llama.cpp CPU build on `127.0.0.1:11435` only. The build disables AVX/AVX2/FMA/F16C/BMI2 for older N3160-class boards, pins model revision and SHA256, and downloads nothing at first boot. This is a small local setup assistant, not a cloud credit subsidy or a performance claim for general agents. Cloud providers remain an explicit later configuration. Account, first-grant, credit reservations and preferences are stored atomically in `.jiaho-onboarding` under application data; reboots drop login state but keep the balance on an installed/persistent filesystem. A nonpersistent Live session loses its accounts/credits on reboot.

The image is built in an amd64 Debian container. On Apple Silicon, the build script uses a native ARM64 QEMU runner for the x86 boot test so the guest does not run nested inside an amd64-emulated builder. Build output is written to `os/artifacts/`:

- `DepDek-AI-OS-amd64.iso` — hybrid BIOS/UEFI installer image.
- `depdek-ai-os-amd64.deb` — the Tauri shell package used by the image.
- `boot-screen.ppm` — QEMU screenshot of the auto-started account page.
- `boot-serial.log` — serial output from the matching boot test.
- `iteration-14-boot.log`, `iteration-15-validation.log`, and `iteration-16-validation.log` — earlier boot, regression, and build-log rotation records.

Run `bash os/build-mvp.sh`. It requires Docker Desktop to be running and enough free disk for a Linux builder, Rust/Node dependencies, the live root filesystem, and the ISO. Each run automatically numbers and saves separate build and boot-test logs in `os/artifacts/`. The build script does not remove Docker images or caches; live-build stores its Linux filesystem cache in the named Docker volume `depdek-ai-os-live-build-cache`. Remove that volume, `depdek-ai-os-builder:trixie`, or `os/artifacts/` yourself after saving artifacts if you need the disk space back.

Build staging excludes nested `target`, `node_modules`, and `dist` directories, local environment files, and the host's Node binary. Node is bundled again from the Linux builder. Rust compilation defaults to four jobs. A complete bundled `vosk-model-small-cn-0.22` is reused rather than downloaded again; the final rootfs must still pass the offline recognition test. Missing model files trigger a bounded, retried download.

Rust compiler output is reusable in the separate `depdek-ai-os-cargo-cache` Docker volume. Only the bootstrap filesystem is reused by live-build. The final SquashFS is rebuilt on every run so that an older cached rootfs cannot silently replace the freshly compiled application. Existing rootfs cache files are left untouched but are no longer consumed.

Python voice dependencies are built into a wheelhouse before entering live-build and installed offline in the chroot. A successful build removes its temporary builder container; a failed run leaves the named `depdek-ai-os-build-N` container for diagnosis or resumption, without touching unrelated containers.

Third-party notices are in [`THIRD_PARTY.md`](THIRD_PARTY.md).

Speech recognition uses the Apache-2.0 `vosk-model-small-cn-0.22` model and a Python Vosk runtime installed in the live image. Audio is capped at 30 seconds, stays in memory, and is not saved. The UI requires the user to review the transcript before sending it to an AI provider. Setup defaults to the bundled local AI; first completion registers it without overwriting existing providers. Later cloud credentials use the existing application credential flow, not an API Key embedded in the ISO.

The build checks package architecture, graphical startup, Plymouth assets, model checksum and offline Vosk loading. The QEMU smoke test disables AVX and waits for the actual AI-OS process and bundled model health via the live serial console before capturing the screen. Physical hardware/USB, UEFI and a complete target-disk install still require their own acceptance; model health alone does not prove successful inference. Native login/credit tests and real inference results are recorded separately.

The native IPC and data rules are documented in [runtime-welcome.md](../docs/agentos-v2/runtime-welcome.md). Local desktop login is separate from Linux accounts, Webdesk admin and R1 business sessions. The automatic OS display session is not disk encryption or a multi-user security claim.
