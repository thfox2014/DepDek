#!/usr/bin/env bash
# 打开 DepDek appliance 的 SSH 访问（需要 root）
#
#   sudo bash scripts/enable-ssh.sh                 # 密码+密钥都可登录（默认，最不容易把自己锁在外面）
#   sudo bash scripts/enable-ssh.sh --key-only      # 只允许密钥登录（先用密码方式验证通过后再切）
#   sudo bash scripts/enable-ssh.sh --user=alice    # 指定要授权的用户（默认当前 sudo 用户）
#
# 做的事：装 openssh-server → 把该用户已有的 ~/.ssh/id_ed25519.pub 授权进 authorized_keys
#        → 写 /etc/ssh/sshd_config.d/99-depdek.conf 基线 → sshd -t 校验 → enable --now ssh → 打印验证结果
set -euo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root：sudo bash scripts/enable-ssh.sh" >&2
  exit 1
fi

TARGET_USER=""
KEY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --key-only) KEY_ONLY=1 ;;
    --user=*) TARGET_USER="${arg#--user=}" ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（见 --help）" >&2; exit 1 ;;
  esac
done

# 解析要授权的用户：--user > $DEPDEK_SSH_USER > $SUDO_USER(非 root) > 仓库属主 > 首个普通用户。
# 单独处理是因为在 root shell（sudo -i / su）里 SUDO_USER 会是 root，
# 那样就会去 /root/.ssh 找公钥、静默跳过授权那一步。
resolve_user() {
  local candidate
  for candidate in "${DEPDEK_SSH_USER:-}" "${SUDO_USER:-}"; do
    if [ -n "$candidate" ] && [ "$candidate" != "root" ] && id "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  candidate="$(stat -c '%U' "$(cd "$(dirname "$0")/.." && pwd)" 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ "$candidate" != "root" ] && id "$candidate" >/dev/null 2>&1; then
    echo "$candidate"
    return
  fi
  awk -F: '$3 >= 1000 && $3 < 60000 { print $1; exit }' /etc/passwd
}

[ -n "$TARGET_USER" ] || TARGET_USER="$(resolve_user)"
if [ -z "$TARGET_USER" ] || ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "无法确定要授权的用户，请用 --user=<name> 指定" >&2
  exit 1
fi
echo "目标用户：$TARGET_USER"

echo "== 1/5 安装 openssh-server"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends openssh-server

echo "== 2/5 授权 $TARGET_USER 已有的公钥"
home="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
key_ready=0
pub=""
if [ -f "$home/.ssh/id_ed25519.pub" ]; then
  pub="$home/.ssh/id_ed25519.pub"
elif compgen -G "$home/.ssh/*.pub" >/dev/null 2>&1; then
  pub="$(compgen -G "$home/.ssh/*.pub" | head -1)"
fi

if [ -n "$pub" ] && [ -f "$pub" ]; then
  install -d -m 700 -o "$TARGET_USER" -g "$TARGET_USER" "$home/.ssh"
  touch "$home/.ssh/authorized_keys"
  chown "$TARGET_USER:$TARGET_USER" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
  if grep -qxF "$(cat "$pub")" "$home/.ssh/authorized_keys"; then
    echo "   已存在，跳过"
  else
    cat "$pub" >> "$home/.ssh/authorized_keys"
    echo "   已写入 authorized_keys ← $(basename "$pub")（指纹：$(ssh-keygen -lf "$pub" | awk '{print $2}')）"
  fi
  key_ready=1
else
  echo "   ⚠ $home/.ssh 下没有 *.pub 公钥，密钥登录不会生效。"
  echo "     先以 $TARGET_USER 身份生成：ssh-keygen -t ed25519 -C \"$TARGET_USER@\$(hostname)\""
  echo "     然后重跑本脚本，或手动执行："
  echo "       install -d -m 700 ~/.ssh && cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  if [ "$KEY_ONLY" -eq 1 ]; then
    echo "   ✗ 你要求 --key-only，但没有可用公钥，继续下去会把自己锁在外面，已中止。" >&2
    exit 1
  fi
fi

echo "== 3/5 写入 /etc/ssh/sshd_config.d/99-depdek.conf"
if [ "$KEY_ONLY" -eq 1 ]; then
  password_auth="no"
else
  password_auth="yes"
fi
cat > /etc/ssh/sshd_config.d/99-depdek.conf <<EOF
# DepDek appliance SSH 基线 —— 由 scripts/enable-ssh.sh 生成，可随时删改
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication $password_auth
KbdInteractiveAuthentication no
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
echo "   PasswordAuthentication = $password_auth、PermitRootLogin = no"

echo "== 4/5 校验配置并启用服务"
sshd -t
systemctl enable --now ssh
systemctl restart ssh

echo "== 5/5 验证"
systemctl is-active ssh | sed 's/^/  服务状态: /'
ss -ltnp 2>/dev/null | grep -E ':22\b' | sed 's/^/  监听: /' || echo "  ⚠ 22 端口未监听"
if [ "$key_ready" -eq 1 ]; then
  echo "  密钥登录: 已写入 authorized_keys（用你自己的私钥试一下）"
else
  echo "  ⚠ 密钥登录: 未就绪（没有公钥），目前只能密码登录"
fi
lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

完成。局域网内其他设备：
  ssh $TARGET_USER@${lan_ip:-<本机IP>}
本机自测（在 $TARGET_USER 自己的终端里，不需要 sudo，先设好 known_hosts）：
  ssh $TARGET_USER@127.0.0.1

提示：
- 当前机器没有防火墙（ufw/nft/iptables 都没装），SSH 一开就对同网段（以及路由器映射后对公网）开放。
- 公网暴露前请务必：--key-only 重跑一次、装 fail2ban、或只走内网/VPN。
EOF
