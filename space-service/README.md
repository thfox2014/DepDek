# depdek-space

Linux 首期逻辑存储空间服务。它不改变现有 Tauri storage_summary，通过一个独立的 Rust 二进制提供：

- 高速 hot、本地长期 durable、云端 cloud 三类资源登记；
- 逻辑空间 space；
- 逻辑对象 space/key 的写入、读取、列表和 SHA-256 校验；
- Unix socket JSON-RPC 服务；
- 适合 systemd user service 的模板。

首期云资源只登记和健康检查，不执行真实云端对象传输；这是为了先稳定逻辑空间、资源模型和服务边界，不影响当前应用设计。

## 本地构建

~~~bash
cargo test --manifest-path space-service/Cargo.toml
cargo build --manifest-path space-service/Cargo.toml --release
~~~

## CLI 验证

~~~bash
BIN=space-service/target/release/depdek-space
ROOT=/tmp/depdek-space-demo
HOT=/tmp/depdek-space-hot
DURABLE=/tmp/depdek-space-durable

rm -rf "$ROOT" "$HOT" "$DURABLE"
mkdir -p "$HOT" "$DURABLE"

"$BIN" --root "$ROOT" init
"$BIN" --root "$ROOT" resource add --name hot-cache --class hot --path "$HOT"
"$BIN" --root "$ROOT" resource add --name local-data --class durable --path "$DURABLE"
"$BIN" --root "$ROOT" resource add --name oss-backup --class cloud \
  --provider s3 --endpoint https://oss.example.invalid --bucket depdek
"$BIN" --root "$ROOT" space create --name projects
echo 'hello from DepDek Space' >/tmp/depdek-space-source.txt
"$BIN" --root "$ROOT" put --space projects --key docs/hello.txt --file /tmp/depdek-space-source.txt
"$BIN" --root "$ROOT" object list --space projects
"$BIN" --root "$ROOT" summary
"$BIN" --root "$ROOT" health
~~~

## 启动 Linux 服务

~~~bash
cargo build --manifest-path space-service/Cargo.toml --release
install -Dm755 space-service/target/release/depdek-space "$HOME/.local/bin/depdek-space"
install -Dm644 deploy/systemd/depdek-space.service \
  "$HOME/.config/systemd/user/depdek-space.service"
systemctl --user daemon-reload
systemctl --user enable --now depdek-space.service

depdek-space --socket "$XDG_RUNTIME_DIR/depdek-space.sock" summary
depdek-space --socket "$XDG_RUNTIME_DIR/depdek-space.sock" health
~~~

服务协议是 Unix socket 上的一行一个 JSON-RPC 2.0 请求，CLI 通过 --socket 使用它。socket 默认权限为 0600。
