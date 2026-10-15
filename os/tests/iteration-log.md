# DepDek AI-OS MVP iteration log

Target: a Debian 13 (Trixie) amd64 hybrid installer ISO that starts the DepDek AI-OS Shell, includes Calamares, initializes the user's DepDek Home, and can run Mandarin voice transcription offline. Each iteration defines or exercises observable acceptance tests; failures and fixes are retained below.

## MVP acceptance tests

| ID | Test | Pass condition | Final result |
|---|---|---|---|
| MVP-01 | Build standard frontend | TypeScript and Vite production build succeed | Pass, iteration 21 (AI-OS and Webdesk) |
| MVP-02 | Validate WAV input | Valid 16 kHz mono PCM is accepted | Pass, Rust test |
| MVP-03 | Reject malformed audio | Empty, corrupt, stereo, zero-length, and over-30-second audio is rejected | Pass, Rust test |
| MVP-04 | Run Rust core and RPC regression tests | Core, RPC and actual bundled setup-model checks pass | Pass, iteration 21: 121 core tests as non-root + 2 RPC + 1 real setup-model test; legacy localhost:8080 model test skipped |
| MVP-05 | Initialize DepDek Home | First run creates `~/DepDek-Home` through the existing vault root validator | Pass: Tauri command is built; live shell shows `/home/live/DepDek-Home` |
| MVP-06 | Open the dedicated AI-OS shell | Graphical boot starts the native Jiaho account page; `depdek-shell` remains a manual entry | Pass, iteration 21: visible account-creation page at 1280×800 |
| MVP-07 | Build the amd64 Debian package | Package metadata says `Architecture: amd64`; shell, sidecar, Node and the voice model are bundled | Pass, iteration 21: 0.2.1 amd64 package; matching package/rootfs application hashes |
| MVP-08 | Boot the hybrid ISO | QEMU reaches the native account page with the bundled model service ready | Pass, iteration 21: BIOS boot with AVX/BMI2 disabled; screenshot manually reviewed |
| MVP-09 | Include the install and post-login path | Calamares is retained; a normal graphical display session starts native AI-OS login | Pass for rootfs contents and Live startup; target-disk installation remains unverified |
| MVP-10 | Run offline Mandarin recognition | Vosk loads with networking disabled and recognizes the fixture's expected words | Pass, iteration 21 finish log (smoke test, not an ASR quality benchmark) |

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
| 21 | Merge current remote main and rebuild the Jiaho graphical first-login edition (2026-10-16). | Pass: amd64 package, ISO, rootfs/model checksum, offline voice, actual local-model/credit persistence and visible BIOS boot. Fixed the Apache license filename, private-account subtree access, absolute-symlink rootfs assertions, serial/splash interaction and mutable build-entry script. Initial root-run credential fixtures were correctly denied; all 121 core tests passed as the ordinary `node` user. See the validation record below. |

### Iteration 21 validation record

- Sources preserve upstream Agent collaboration changes, native first-login/credits and the Jiaho boot assets. `main` was pushed without a force update; HTTPS temporarily failed and the existing verified SSH identity was used.
- Frontend and Webdesk production builds passed; sidecar: 16 files / 143 tests; browser-computer boundary: 1 test; Rust core: 121 tests as non-root; RPC: 2 tests. The old localhost:8080 model test reported an unavailable endpoint and was not counted as a real inference pass.
- `welcome_bundled` explicitly used the actual pinned Qwen model: first grant 1,000 → one successful request 990 → replay/restart/login still 990; preferences persisted. Default test runs ignore this case unless the bundled local service is explicitly started.
- Image build completed, but editing its host-mounted running entry script interrupted the finishing commands. Rootfs/voice checks, cleanup and final copy were completed explicitly from the retained build container; future builds run a private entry-script snapshot. The temporary builder was removed after matching hashes and saving the ISO.
- BIOS QEMU boot used 4 GB RAM, two CPUs and disabled AVX/AVX2/FMA/F16C/BMI2. The actual Plymouth logo and first account-creation page were visually inspected, not inferred from a process marker. Bundled-model `/health` was ready. UEFI boot metadata is present; UEFI execution itself was not tested.
- ISO SHA256: `1001470378660edb4429e54faa415411d1941fe73bc145801f1a62ca3735eea6`.
- Debian package SHA256: `f0b3fc978b4288ee6e334d243e6bcf2e2ffa6a02a10d72f9488df89a8d5238b2`.
- Application binary in package and staged rootfs: `3fab5de3b39aae9c9d8573a606b312f11094a94c247d1739fcfc18b165b52241`.
- Evidence under `artifacts/`: `iteration-21-build.log`, `iteration-21-finish.log`, `iteration-21-core-tests-nonroot.log`, `iteration-21-integration-tests.log`, `iteration-21-welcome-real-tests.log`, `iteration-21-iso-inspection.log`, `iteration-21-boot.log`, `boot-splash-iteration21.png`, `boot-login-iteration21.png`, and `SHA256SUMS`.

## MVP result and remaining validation

The current `DepDek-AI-OS-amd64.iso` and matching `.deb` are the rebuilt iteration-21 artifacts. They replace the earlier CLI-first proposal with Jiaho graphical boot, native account creation, 1,000 once-only setup points and an offline configuration assistant. A previous image remains in `artifacts/pre-20261015-build/`.

The new Jiaho edition was BIOS boot-tested in QEMU. Physical USB boot, UEFI execution and a complete Calamares install onto a target disk remain unverified. No USB was written and no remote machine was deployed in iteration 21. Setup points are local configuration-experience points, not commercial cloud credits or a multi-user NAS identity system.

The 2026-10-15 refresh retains the prior ISO/package under `artifacts/pre-20261015-build/`. The new artifacts are an MVP test build, not a production release: npm reported high/critical dependency advisories which were not force-upgraded or triaged here, and no real cloud model request was made. The current Shell's “已连接” provider label is not proof of a successful cloud connection. Full V2 NAS service provisioning and physical installation acceptance remain outside this build.
