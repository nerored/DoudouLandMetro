#!/usr/bin/env bash
# =============================================================================
# bump-version.sh — 生成 version.json（页面用它显示版本戳、判断是否已更新）
#
# 发版流程（推荐顺序）：
#   1) 改代码 → git commit（这一步产生的 hash 就是版本要记录的 commit）
#   2) ./tools/bump-version.sh          # 重新生成 version.json
#   3) git add version.json && git commit -m "chore: 更新版本戳"
#   4) git push origin main             # Pages 自动重建
#
# 为什么不把版本常量写在 app.js 里：那样每次发版要手动改常量，容易忘；
# 用 version.json 的好处是「版本 = 仓库里的文件」，页面每次都用
# fetch('version.json', {cache:'no-store'}) 现取，永远不会记错。
# 注意：commit 字段记录的是“生成 version.json 那一刻的 HEAD”，
# 也就是上一步的代码提交（因为版本戳本身要在下一次提交里落库）。
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="$(date +%Y-%m-%d.%H%M)"
BUILT_AT="$(date -Iseconds)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

cat > version.json <<EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "builtAt": "$BUILT_AT"
}
EOF

echo "version.json 已更新：version=$VERSION commit=$COMMIT builtAt=$BUILT_AT"
