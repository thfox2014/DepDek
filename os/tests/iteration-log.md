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
| MVP-06 | Show the dedicated AI-OS shell | Live boot opens the focused shell; voice transcript is reviewed before sending | Pass: observed on the final QEMU screenshot |
| MVP-07 | Build the amd64 Debian package | Package metadata says `Architecture: amd64`; shell, sidecar, Node, and offline model are bundled | Pass: iteration 15 package inspection |
| MVP-08 | Boot the hybrid ISO | QEMU boots the image and the branded DepDek UI appears in a captured frame | Pass: iteration 14, 1280x800 screenshot |
| MVP-09 | Include the install and post-login path | Calamares and its launcher are installed; the shell has a system-wide autostart entry | Pass: live-rootfs assertions; shell autostart observed in QEMU |
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

## MVP result and remaining validation

The software MVP is met: an amd64 Debian hybrid installer ISO and matching Debian package were produced; the final ISO reached the live DepDek Shell in QEMU; Calamares, its `Install DepDek AI-OS` launcher, and post-login shell autostart are in the live root filesystem; and the voice model passed an offline smoke test.

The current environment has no physical x86 machine attached. The ISO was boot-tested with the BIOS path in QEMU; physical USB boot, UEFI boot, and a complete Calamares install onto a virtual or physical target disk remain follow-up checks. The current QEMU test inspects the live desktop and does not write to a host disk.
