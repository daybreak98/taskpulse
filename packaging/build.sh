#!/bin/bash
# 构建可分发的 macOS 安装包（zip）。
#   用法：./packaging/build.sh            对外分发的干净包
#         ./packaging/build.sh internal   团队内部包（附带已填好的配置）
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-public}"
VER="$(date +%Y%m%d)"
SUFFIX=""
[ "$MODE" = "internal" ] && SUFFIX="-internal"
OUT="dist/TaskPulse-$VER$SUFFIX"
APP="TaskPulse.app"

echo "== 1/4 编译并签名 App =="
rm -f "$APP/Contents/MacOS/"*.bak* 2>/dev/null || true
# 通用二进制：Apple Silicon + Intel 都能跑
TMPB="$(mktemp -d)"
trap 'rm -rf "$TMPB"' EXIT
# swiftc 只允许名为 main.swift 的文件写顶层代码，这里换名后再编译多文件
cp pulse.swift "$TMPB/main.swift"
for target in arm64 x86_64; do
  swiftc -O -target "$target-apple-macos13.0" -o "$TMPB/TaskPulse-$target" \
    "$TMPB/main.swift" onboarding.swift -framework Cocoa
done
lipo -create -output "$APP/Contents/MacOS/TaskPulse" "$TMPB/TaskPulse-arm64" "$TMPB/TaskPulse-x86_64"
codesign --force --deep --sign - "$APP"
echo "   -> $APP ($(lipo -archs "$APP/Contents/MacOS/TaskPulse"))"

echo "== 2/4 组装目录 =="
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R "$APP" "$OUT/"
cp poller.py "$OUT/"
# edge-ext/config.js 是按本机配置生成的，不进包（install.command 会重新生成）
mkdir -p "$OUT/edge-ext"
for f in "$PWD"/edge-ext/*; do
  case "$(basename "$f")" in config.js) continue ;; esac
  cp -R "$f" "$OUT/edge-ext/"
done
cp packaging/install.command packaging/uninstall.command packaging/README.md "$OUT/"
chmod +x "$OUT/install.command" "$OUT/uninstall.command"
mkdir -p "$OUT/docs" && cp docs/product-spec.md "$OUT/docs/"

# 内部包：config.json 与 uv-args.txt 来自 packaging/internal/（不入库）
if [ "$MODE" = "internal" ]; then
  if [ ! -f packaging/internal/config.json ]; then
    echo "!! 缺少 packaging/internal/config.json" >&2
    exit 1
  fi
  cp packaging/internal/config.json "$OUT/"
  [ -f packaging/internal/uv-args.txt ] && cp packaging/internal/uv-args.txt "$OUT/"
  echo "   -> 已附内部配置"
fi
echo "   -> $OUT"

echo "== 3/4 打包 zip =="
ZIP="TaskPulse-$VER$SUFFIX.zip"
( cd dist && rm -f "$ZIP" && zip -qry "$ZIP" "TaskPulse-$VER$SUFFIX" )
echo "   -> dist/$ZIP ($(du -h "dist/$ZIP" | cut -f1))"

echo "== 4/4 自检 =="
unzip -l "dist/$ZIP" | tail -20
