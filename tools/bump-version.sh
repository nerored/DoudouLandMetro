#!/usr/bin/env bash
# =============================================================================
# bump-version.sh — 生成 version.json（页面用它显示版本戳、判断是否已更新）
#
# 发版流程（推荐顺序）：
#   1) 改代码 → git commit（这一步产生的 hash 就是版本要记录的 commit）
#   2) ./tools/bump-version.sh          # 重新生成 version.json，并把 index.html 里的版本号换掉
#   3) git add version.json index.html && git commit -m "chore: 更新版本戳"
#   4) git push origin main             # Pages 自动重建
#
# 为什么版本号要同时写进 index.html（2026-09-13 性能批次 P1-2）：
#   以前是「先 fetch version.json（no-store，串行一个 RTT）→ 再把 data.js/app.js/style.css 用 ?v= 注入」，
#   大资源要等小请求回来才开始下载，而 JS 注入的资源 preload 扫描器也发现不了；
#   现在改成 **index.html 里直接写静态 <link>/<script> 带 ?v=<版本>**，版本号由本脚本同步维护：
#   资源能被提前发现、不再多一次 RTT，也不再重复取一份 style.css。
# 注意：commit 字段记录的是“生成 version.json 那一刻的 HEAD”，
# 也就是上一步的代码提交（因为版本戳本身要在下一次提交里落库）。
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OLD="$(grep -o '"version": *"[^"]*"' version.json 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
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

# index.html 里的 ?v=<旧版本> / __VER__ / 两行版本常量 一并换成新版本
# （正则换字面值，所以重复发版也准：不依赖占位符还在）
if [ -n "$OLD" ] && { [ "$OLD" != "$VERSION" ] || grep -q '__VER__\|__COMMIT__' index.html; }; then
  n=$(grep -c "?v=$OLD\|__VER__" index.html || true)
  sed -i "s/?v=$OLD/?v=$VERSION/g; s/__VER__/$VERSION/g; \
    s/__BUILD_VERSION = '[^']*'/__BUILD_VERSION = '$VERSION'/; \
    s/__BUILD_COMMIT = '[^']*'/__BUILD_COMMIT = '$COMMIT'/" index.html
  if [ "$n" = "0" ]; then
    echo "!! index.html 里没有找到版本号（?v=$OLD 或 __VER__）：静态资源不会被刷新，检查发版流程" >&2
    exit 1
  fi
  echo "index.html 已同步：版本 $OLD → $VERSION，commit = $COMMIT"
fi

echo "version.json 已更新：version=$VERSION commit=$COMMIT builtAt=$BUILT_AT"
