#!/usr/bin/env bash
# /tmp/check-ver.sh <base-url>  —— 校验「缓存击穿硬约束」：静态 ?v= == version.json 版本 == __BUILD_VERSION
set -uo pipefail
BASE="${1:-http://localhost:8099/index.html}"
CB=$(date +%s)
HTML=$(curl -s "$BASE?cb=$CB")
VER=$(curl -s "${BASE%/index.html}/version.json?cb=$CB" | tr -d '\n ' | sed 's/.*"version":"\([^"]*\)".*/\1/')
COM=$(curl -s "${BASE%/index.html}/version.json?cb=$CB" | tr -d '\n ' | sed 's/.*"commit":"\([^"]*\)".*/\1/')
VERS=$(echo "$HTML" | grep -o '?v=[0-9][0-9.-]*' | sed 's/?v=//' | sort -u | tr '\n' ' ')
BV=$(echo "$HTML" | grep -o "__BUILD_VERSION = '[^']*'" | sed "s/.*'\(.*\)'/\1/")
BC=$(echo "$HTML" | grep -o "__BUILD_COMMIT = '[^']*'" | sed "s/.*'\(.*\)'/\1/")
NV=$(echo "$VERS" | wc -w)
echo "version.json : version=$VER commit=$COM"
echo "index.html   : ?v=($NV 个) = $VERS | __BUILD_VERSION=$BV | __BUILD_COMMIT=$BC"
if [ "$NV" = "1" ] && [ "$VERS" = "$VER " ] && [ "$BV" = "$VER" ] && [ "$BC" = "$COM" ]; then
  echo "CHECK: PASS（静态资源版本号与 version.json / __BUILD_VERSION 完全一致）"
else
  echo "CHECK: FAIL"
  exit 1
fi
