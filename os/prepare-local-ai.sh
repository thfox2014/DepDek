#!/usr/bin/env bash
set -euo pipefail
# Run in the Linux builder. Nothing is fetched at the user's first boot.
destination="$(realpath "$1")"
cache="${2:-/live-cache/jiaho-ai}"
revision=4762ad7316dcdec20016ab5985fb46a27902204d
model_revision=2ed9be962c95f7625f4963ff51ed472e4538187a
model_sha=74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db
model_file=qwen2.5-0.5b-instruct-q4_k_m.gguf
build="$cache/llama-$revision-noavx-v1"
mkdir -p "$cache" "$build" "$destination/usr/lib/jiaho" "$destination/usr/share/jiaho/models" "$destination/usr/share/doc/jiaho-ai"
if [ ! -x "$build/build/bin/llama-server" ]; then
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
    "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/$revision" -o "$cache/llama-source.tar.gz"
  tar -xzf "$cache/llama-source.tar.gz" --strip-components=1 -C "$build"
  # N3160 has no AVX. Do not inherit the builder machine's instruction set.
  cmake -S "$build" -B "$build/build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF \
    -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_LLAMAFILE=OFF \
    -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
  cmake --build "$build/build" --target llama-server -j "${CARGO_BUILD_JOBS:-4}"
fi
model="$cache/$model_file"
if ! printf '%s  %s\n' "$model_sha" "$model" | sha256sum -c - >/dev/null 2>&1; then
  path="Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/$model_revision/$model_file"
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 1200 \
    "https://huggingface.co/$path" -o "$model.partial" || \
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 1200 \
    "https://hf-mirror.com/$path" -o "$model.partial"
  printf '%s  %s\n' "$model_sha" "$model.partial" | sha256sum -c -
  mv "$model.partial" "$model"
fi
install -m 0755 "$build/build/bin/llama-server" "$destination/usr/lib/jiaho/llama-server"
install -m 0644 "$model" "$destination/usr/share/jiaho/models/setup.gguf"
install -m 0644 "$build/LICENSE" "$destination/usr/share/doc/jiaho-ai/llama-LICENSE"
install -m 0644 /usr/share/common-licenses/Apache-2 "$destination/usr/share/doc/jiaho-ai/Qwen-LICENSE"
printf 'llama.cpp %s (MIT), no AVX\nQwen/Qwen2.5-0.5B-Instruct-GGUF %s (Apache-2.0)\nSHA256 %s\n' "$revision" "$model_revision" "$model_sha" > "$destination/usr/share/doc/jiaho-ai/SOURCES"
echo 'Bundled local setup AI is verified and ready.'
