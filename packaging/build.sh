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

echo "== 1/4 编译并签名 App =="
# 为什么要在临时目录里组装：干净检出里没有 TaskPulse.app（.gitignore 忽略了它），
# 以前直接往工作区写 Contents/MacOS 会在别的机器/CI 上直接失败，
# 而且会把签名产物和 _CodeSignature 留在仓库里。现在仓库只提供 Bundle 元数据。
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/TaskPulse.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Bundle 元数据来自版本控制（packaging/Info.plist），不依赖工作区里那份可能不存在的 Info.plist
cp packaging/Info.plist "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
# 通用二进制：Apple Silicon + Intel 都能跑
TMPB="$STAGE/build"
mkdir -p "$TMPB"
# swiftc 只允许名为 main.swift 的文件写顶层代码，这里换名后再编译多文件
cp pulse.swift "$TMPB/main.swift"
for target in arm64 x86_64; do
  swiftc -O -target "$target-apple-macos13.0" -o "$TMPB/TaskPulse-$target" \
    "$TMPB/main.swift" onboarding.swift -framework Cocoa
done
lipo -create -output "$APP/Contents/MacOS/TaskPulse" "$TMPB/TaskPulse-arm64" "$TMPB/TaskPulse-x86_64"
chmod +x "$APP/Contents/MacOS/TaskPulse"
codesign --force --deep --sign - "$APP"
# 先自检再往下走：签名不通过就在这里失败，别把坏包做出来
codesign --verify --deep --strict "$APP"
echo "   -> $APP ($(lipo -archs "$APP/Contents/MacOS/TaskPulse"))"

echo "== 2/4 组装目录 =="
rm -rf "$OUT" && mkdir -p "$OUT"
# 临时目录里已经签名并自检过，这里才落地到 dist/
cp -R "$APP" "$OUT/"
# 拷贝后再确认一次：打包落地的产物必须仍然是有效签名
codesign --verify --deep --strict "$OUT/TaskPulse.app"
cp poller.py "$OUT/"
# edge-ext/config.js 与 manifest.json 是按本机配置生成的，不进包（install.command 会重新生成）
# *.bak* 是编辑器备份，同样不进包
mkdir -p "$OUT/edge-ext"
for f in "$PWD"/edge-ext/*; do
  case "$(basename "$f")" in config.js|manifest.json|*.bak*) continue ;; esac
  cp -R "$f" "$OUT/edge-ext/"
done
# health_check.sh 随包分发：install.command 用它区分「进程在线」和「取数就绪」
cp packaging/install.command packaging/uninstall.command packaging/health_check.sh \
   packaging/api_check.command packaging/api_login.command packaging/README.md "$OUT/"
chmod +x "$OUT/install.command" "$OUT/uninstall.command" "$OUT/health_check.sh" \
         "$OUT/api_check.command" "$OUT/api_login.command"
mkdir -p "$OUT/docs" && cp docs/product-spec.md docs/INSTALL.md docs/fixes-summary.md "$OUT/docs/"
cp docs/INSTALL.md "$OUT/INSTALL.md"     # 用户第一眼就能看到，不用进 docs 目录找

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
