#!/bin/bash
# 生成安装包自带的 uv 与 Python 运行时（体积大，不入库）。
# 用法：./vendor.sh        已存在的文件会跳过，可重复执行
set -euo pipefail
cd "$(dirname "$0")"

VENDOR="vendor"
UV_VERSION="0.13.10"
PY_VERSION="3.15.2"
mkdir -p "$VENDOR"

# uv：只留 uv 本体（uvx 用不到），gzip 后约 12MB/架构
for arch in aarch64 x86_64; do
  out="$VENDOR/uv-$arch.gz"
  [ -s "$out" ] && { echo "-- 已有 $out"; continue; }
  echo "-- 下载 uv $UV_VERSION ($arch)"
  tmp="$(mktemp -d)"
  curl -sSL -o "$tmp/uv.tgz" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$arch-apple-darwin.tar.gz"
  tar -xzf "$tmp/uv.tgz" -C "$tmp"
  gzip -9 -c "$tmp/uv-$arch-apple-darwin/uv" > "$out"
  rm -rf "$tmp"
  echo "   -> $(du -h "$out" | cut -f1)"
done

# Python：由 uv 自己下过一次之后打包，安装时直接解压到 uv 的 managed 目录
for arch in aarch64 x86_64; do
  out="$VENDOR/python-$arch.tar.xz"
  [ -s "$out" ] && { echo "-- 已有 $out"; continue; }
  name="cpython-$PY_VERSION-macos-$arch-none"
  src="$HOME/.local/share/uv/python/$name"
  if [ ! -d "$src" ]; then
    echo "-- 本地缺 $name，先用 uv 装上"
    uv python install "$name"
  fi
  echo "-- 打包 $name"
  tar -cJf "$out" -C "$src" .
  echo "   -> $(du -h "$out" | cut -f1)"
done

echo "$PY_VERSION" > "$VENDOR/python-version.txt"
echo "== vendor 就绪：$(du -sh "$VENDOR" | cut -f1)"
