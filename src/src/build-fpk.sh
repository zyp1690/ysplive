#!/bin/bash
# 本地重建 fnOS 安装包：./build-fpk.sh
# 依赖：Linux x86_64、curl。fnpack 会自动下载到 .bin/ 目录
set -euo pipefail

cd "$(dirname "$0")"

FNPACK_VER=1.2.3
BIN_DIR=".bin"

mkdir -p "$BIN_DIR"
if [ ! -x "$BIN_DIR/fnpack" ]; then
    echo "[1/3] 下载 fnpack ${FNPACK_VER} ..."
    curl -fsSL -o "$BIN_DIR/fnpack" "https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VER}-linux-amd64"
    chmod +x "$BIN_DIR/fnpack"
fi

APPNAME="$(awk -F'=' '/^appname/{gsub(/[[:space:]]/,"",$2);print $2}' manifest)"
VER="$(awk -F'=' '/^version/{gsub(/[[:space:]]/,"",$2);print $2}' manifest)"
[ -n "$APPNAME" ] || { echo "无法从 manifest 读取 appname"; exit 1; }
[ -n "$VER" ] || { echo "无法从 manifest 读取版本号"; exit 1; }

# cmd/ 下的脚本必须保持可执行位，否则应用中心无法启停应用
chmod 755 cmd/*

echo "[2/3] 打包中（版本 ${VER}）..."
rm -f ysp-live.fpk "${APPNAME}".fpk "${APPNAME}"-*.fpk 2>/dev/null || true
"$BIN_DIR/fnpack" build --directory .

OUT="${APPNAME}-${VER}-fnos-all.fpk"
if [ -f ysp-live.fpk ]; then mv ysp-live.fpk "$OUT"; else mv "${APPNAME}.fpk" "$OUT"; fi
sha256sum "$OUT" > "${OUT}.sha256"

echo "[3/3] 完成：${OUT}"
cat "${OUT}.sha256"
