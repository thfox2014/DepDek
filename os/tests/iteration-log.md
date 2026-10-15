# DepDek AI-OS MVP iteration log

Target: a Debian 13 (Trixie) amd64 hybrid installer ISO that starts the DepDek AI-OS Shell, includes Calamares, initializes the user's DepDek Home, and can run Mandarin voice transcription offline. Each iteration defines or exercises observable acceptance tests; failures and fixes are retained below.

## MVP acceptance tests

| ID | Test | Pass condition | Final result |
|---|---|---|---|
| MVP-01 | Build standard frontend | TypeScript and Vite production build succeed | Pass, iteration 15 |
| MVP-02 | Validate WAV input | Valid 16 kHz mono PCM is accepted | Pass, Rust test |
| MVP-03 | Reject malformed audio | Empty, corrupt, stereo, zero-length, and over-30-second audio is rejected | Pass, Rust test |
| MVP-04 | Run Rust core and RPC regression tests | All unit, local-model e2e, and RPC integration tests pass | Pass: 31 + 1 + 2, iteration 15 |
| MVP-05 | Initialize DepDek Home | First run creates `~/DepDek-Home` through the existing vault root validator | Pass: Tauri command is built; live shell shows `/home/live/DepDek-Home` |
| MVP-06 | Open the dedicated AI-OS shell | Graphical boot starts the native Jiaho account page; `depdek-shell` remains a manual entry | Implemented for iteration 21; build verification pending |
| MVP-07 | Build the amd64 Debian package | Package metadata says `Architecture: amd64`; shell, sidecar, Node, and offline model are bundled | Pass: iteration 15 package inspection |
| MVP-08 | Boot the hybrid ISO | QEMU reaches the native account page with the bundled model service ready | Implemented for iteration 21; build verification pending |
| MVP-09 | Include the install and post-login path | Calamares is retained; a normal graphical display session starts native AI-OS login | Implemented for iteration 21; physical installation verification pending |
| MVP-10 | Run offline Mandarin recognition | Vosk loads with networking disabled and recognizes the fixture's expected words | Pass: iteration 11 build log |

## Iteration history

| Iteration | Designed check and result | Evidence / correction |
|---|---|---|
| 1 | Define and implement the shell, voice input contract, Home initialization, and package/image acceptance cases above. | Frontend and Rust validation tests added; transcript review is required before sending. |
| 2–7 | Build the amd64 package and Debian rootfs; check the package set against Debian Trixie. | Resolved container chroot/cache permission failures and the removed `policykit-1` package by using the privileged live-build container and Trixie's `pkexec` package. Detailed build logs remain in `artifacts/iteration-02` through `iteration-07`. |
| 8 | Build the hybrid ISO, run rootfs and offline Vosk checks, then boot under QEMU. | Image, Calamares/autostart assertions, and Vosk passed. The initial QEMU run timed out at 240 seconds while GRUB was still waiting on its menu/font setup. |
| 9–10 | Recheck GRUB and Linux boot, then run x86 TCG on the host's native ARM64 QEMU runner. | Fixed the GRUB font/menu configuration and moved nested x86 emulation out of the amd64 builder. One run exposed a host/container ISO path mismatch; the wrapper now passes `/workspace/os/artifacts/DepDek-AI-OS-amd64.iso`. |
| 11–13 | Inspect serial output and VNC frames after the LightDM service marker. | The screenshot was still black after the old fixed 60-second delay. This was a test timing error: LightDM's start marker precedes Xfce and the Tauri shell by several minutes under ARM-hosted x86 TCG. Switching from hidden display to VNC alone did not fix it; an extended live boot showed the shell on graphical VT7. |
| 14 | Poll QEMU screenshots until the DepDek dark UI's lime accent is present; save serial log and frame. | Pass. Final ISO showed the shell at 1280x800 with 13,438 lime-accent pixels. The test now times out only after 900 seconds and no longer equates a LightDM marker with desktop readiness. |
| 15 | Rerun both frontend builds, all Rust tests, package metadata/content checks, ISO metadata, script syntax, and whitespace validation. | Pass. See `artifacts/iteration-15-validation.log`; build/rootfs/Vosk evidence is also in `artifacts/iteration-11-full-build.log`. |
| 16 | Check that the build wrapper chooses the next log number after existing iterations, including IDs with leading zeroes. | First check exposed Bash interpreting `08` and `09` as octal. The wrapper now forces decimal parsing; the corrected check passes and is saved in `artifacts/iteration-16-validation.log`. Future builds create paired numbered build and boot logs. |
| 17 | Rebuild from the updated `main` and preserved AgentOS changes (2026-10-15). | Model download failed with a TLS EOF. Recovered the identical Mandarin model asset from the retained previous local `.deb`; excluded host compiler/dependency caches and local env files from staging. |
| 18 | Compile the current amd64 application and assemble a fresh rootfs. | New `0.2.1` `.deb` compiled successfully; chroot DNS blocked pip. Disabled reuse of the final rootfs cache to prevent silently packaging an older application. |
| 19 | Use the newly built `.deb`, prebuild Python wheels outside the chroot, install them offline, and build/boot the new ISO. | Pass: rootfs/autostart/Calamares and offline Vosk smoke checks, BIOS/UEFI ISO boot metadata, matching application hashes in `.deb`/chroot/SquashFS, and visible QEMU BIOS Shell at 1280×800 (10,537 lime pixels). Evidence: `artifacts/iteration-19-validation.md`, `iteration-19-build.log`, `iteration-19-boot.log`, `boot-screen-iteration19.png`, and `SHA256SUMS`. |
| 20 | Attempt the CLI-first redesign, then supersede it with the user's Jiaho first-login flow. | Added GRUB/Plymouth branding, native login, once-only setup points and the bundled local assistant. Docker stopped during compilation; no new ISO was produced. |
| 21 | Merge current remote main and rebuild the Jiaho graphical first-login edition (2026-10-16). | Preserve remote collaboration features, apply the login gate to their control commands, disable BMI2 as well as AVX for the local runtime, and reuse compiler output. Build/boot verification in progress. |

## MVP result and remaining validation

The prior ISO/package remain available. The current sources replace the earlier CLI-first proposal with Jiaho graphical boot, native account creation, 1,000 once-only setup points and an offline configuration assistant. The new image must finish build and boot verification before it is used as updated installation media.

The earlier ISO was boot-tested with the BIOS path in QEMU. The new Jiaho edition is not yet boot-verified; physical USB boot, UEFI boot, and a complete Calamares install onto a target disk also remain unverified.

The 2026-10-15 refresh retains the prior ISO/package under `artifacts/pre-20261015-build/`. The new artifacts are an MVP test build, not a production release: npm reported high/critical dependency advisories which were not force-upgraded or triaged here, and no real cloud model request was made. The current Shell's “已连接” provider label is not proof of a successful cloud connection. Full V2 NAS service provisioning and physical installation acceptance remain outside this build.
