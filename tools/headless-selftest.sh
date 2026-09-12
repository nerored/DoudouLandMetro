#!/usr/bin/env bash
# =============================================================================
# headless-selftest.sh — 用无头 Edge 跑页面自检（?selftest=1），并**保证清理**：
#   无论成功/失败/超时，退出时都会关掉这次启动的 Edge 进程并删掉临时 profile。
#
# 用法:
#   ./tools/headless-selftest.sh                                  # 默认本机 8080 + 1180x820
#   ./tools/headless-selftest.sh 'http://localhost:8080/index.html?selftest=1' 820x1180
#   BUDGET=15000 ./tools/headless-selftest.sh                     # 改虚拟时间预算
# 环境变量: EDGE=<msedge 可执行文件路径>  BUDGET=<虚拟时间预算 ms>  ALL=1 打印全部断言（默认只打失败的 + 几条抽样）
# =============================================================================
set -uo pipefail

URL="${1:-http://localhost:8080/index.html?selftest=1}"
SIZE="${2:-1180x820}"
EDGE="${EDGE:-/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
BUDGET="${BUDGET:-12000}"

# 专用临时 profile：只用来识别“本次启动的 Edge”，清理时不会误伤用户自己开的 Edge
PROFILE_WIN='C:\temp\potato-selftest'
PROFILE_MATCH='potato-selftest'
PROFILE_WSL='/mnt/c/temp/potato-selftest'
OUT="$(mktemp /tmp/selftest-dom.XXXXXX.html)"

cleanup() {
  powershell.exe -NoProfile -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*${PROFILE_MATCH}*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
    >/dev/null 2>&1 || true
  rm -rf "$PROFILE_WSL" 2>/dev/null || true
  rm -f "$OUT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

W="${SIZE%x*}"; H="${SIZE#*x}"
echo "== 无头自检: $URL  ($W x $H, budget=${BUDGET}ms)"
timeout -k 5 180 "$EDGE" --headless=new --disable-gpu --no-first-run \
  --disable-extensions --disable-sync --user-data-dir="$PROFILE_WIN" \
  --virtual-time-budget="$BUDGET" --window-size="$W,$H" \
  --dump-dom "$URL" > "$OUT" 2>/dev/null
EDGE_EXIT=$?
echo "== Edge 退出码: $EDGE_EXIT（124=超时）"

python3 - "$OUT" <<'PY'
import re, json, html, sys, os
s = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
m2 = re.search(r'<pre id="selftest">(.*?)</pre>', s, re.S)
if not m2:
    m = re.search(r'<title>(.*?)</title>', s, re.S)
    print('NO SELFTEST:', (html.unescape(m.group(1))[:140] if m else '(无 title)'))
    sys.exit(2)
d = json.loads(html.unescape(m2.group(1)))
bad = [c for c in d['checks'] if not c['pass']]
print(('SELFTEST-PASS' if d['ok'] else 'SELFTEST-FAIL'),
      'checks', len(d['checks']), 'pass', len(d['checks']) - len(bad))
for c in bad:
    print('  FAIL:', c['name'], '|', str(c['detail'])[:160])
if os.environ.get('ALL'):
    for c in d['checks']:
        print('   ', ('P' if c['pass'] else 'F'), c['name'][:60], '|', str(c['detail'])[:170])
for c in d['checks']:
    if any(k in c['name'] for k in ('刷新', '报站', '位置', '有界', '列表', '版本号')):
        print('   ', ('P' if c['pass'] else 'F'), c['name'][:44], '|', str(c['detail'])[:110])
sys.exit(0 if d['ok'] else 1)
PY
