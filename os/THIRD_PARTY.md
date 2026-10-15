# Third-party components shipped with the MVP

- Vosk speech recognition runtime: Apache License 2.0; upstream: [alphacep/vosk-api](https://github.com/alphacep/vosk-api).
- Mandarin acoustic model `vosk-model-small-cn-0.22`: published as Apache License 2.0 by the [Vosk model catalogue](https://alphacephei.com/vosk/models).
- Debian installer and base system: Debian 13 packages. Package-specific notices and license texts remain in the installed Debian system under `/usr/share/doc` and `/usr/share/common-licenses`.
- Jiaho default setup model: [Qwen/Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF), Apache-2.0; revision `2ed9be962c95f7625f4963ff51ed472e4538187a`, Q4_K_M SHA256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.
- CPU model runtime: [llama.cpp](https://github.com/ggml-org/llama.cpp), MIT; revision `4762ad7316dcdec20016ab5985fb46a27902204d` (b6000). Corresponding notices are installed at `/usr/share/doc/jiaho-ai`.
- Jiaho boot and login artwork: derived with built-in ImageGen from the user's approved Jiaho h-door brand design. Source image and prompts remain in `docs/brand/`; the shipped cream-background lockup is `src/assets/jiaho-boot-logo.png`.
