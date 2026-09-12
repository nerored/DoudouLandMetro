#!/usr/bin/env bash
# =============================================================================
# serve.sh - 在本机启动静态服务器（零依赖，仅用 python3 标准库）
#   用法:  ./serve.sh [端口]        默认 8080
#   例:    ./serve.sh 8080
# 说明：应用是纯静态的，也可以直接 file:// 打开 index.html；
#       用 http 服务主要是为了方便 iPad 等其它设备访问。
# =============================================================================
set -euo pipefail
PORT="${1:-8080}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "== 目录: $DIR"
echo "== 端口: $PORT"

# WSL2 里能拿到的几个地址，供 iPad 访问参考
WIN_HOST_IP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -n1 || true)"
RESOLV_IP="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))' | head -n1 || true)"

echo
echo "== 本机自检:      http://127.0.0.1:${PORT}/index.html"
echo "== Windows 宿主:  http://${WIN_HOST_IP:-<win-host-ip>}:${PORT}/index.html   (WSL2 默认网关, 通常即宿主)"
[ -n "${RESOLV_IP:-}" ] && echo "== resolv.conf:   http://${RESOLV_IP}:${PORT}/index.html"
[ -n "${LAN_IP:-}" ] && echo "== 局域网地址:    http://${LAN_IP}:${PORT}/index.html"
echo
cat <<'HINT'
-----------------------------------------------------------------------------
iPad 访问步骤（WSL2 下推荐做法）：
 1) 本脚本已用 --bind 0.0.0.0 监听，WSL2 内部所有接口都可访问。
 2) 让 Windows 把端口转发到 WSL（管理员 PowerShell 执行一次）：
      netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 `
        connectport=8080 connectaddress=<WSL_IP>
      # <WSL_IP> = 上面打印的 “本机自检” 之外的任一 WSL 地址；用 `hostname -I` 查看
 3) 放行防火墙（管理员 PowerShell）：
      netsh advfirewall firewall add rule name="potato-8080" dir=in action=allow protocol=TCP localport=8080
 4) iPad 与电脑连同一个 Wi-Fi，浏览器打开：
      http://<Windows宿主局域网IP>:8080/index.html
    （在 Windows 上执行 ipconfig 找 “IPv4 地址”，一般是 192.168.x.x）

若第 2 步的 hostproxy 不稳定（WSL2 偶数/奇数版本差异），也可以：
  a) 直接访问 WSL 的 IP（上面打印的 172.x.x.x），前提是 Windows 防火墙允许；
  b) 或把整个目录复制到 Windows 侧（例如 C:\potato），在 Windows 上用
     `python -m http.server 8080` 起服务；应用零依赖，直接 file:// 打开也能跑。
  c) 检查转发是否生效： netsh interface portproxy show v4tov4
-----------------------------------------------------------------------------
HINT
echo "== 启动服务器（Ctrl+C 结束）..."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
