#!/bin/bash
# 构建「免费个人内测包」：ZIP 里只有一个 TaskPulse.app + 使用说明。
#
# 同事不需要跑 install.command、不需要终端、不需要预装 Python：
# 双击 App 后由 App 自己把运行环境准备到用户目录（见 Bootstrap.swift）。
#
#   用法：./packaging/build.sh
#
# 依赖：本机跑过一次 ./packaging/vendor.sh（生成自带的 uv / Python，不入库），
#      以及 packaging/internal/{config.json,uv-args.txt}。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

VER="$(date +%Y%m%d)"
NAME="TaskPulse-$VER-personal"
OUT="dist/$NAME"

if [ ! -d packaging/vendor ] || [ -z "$(ls -A packaging/vendor 2>/dev/null)" ]; then
  echo "!! 缺少 packaging/vendor（自带的 uv / Python），先跑一次 ./packaging/vendor.sh" >&2
  exit 1
fi
if [ ! -f packaging/internal/config.json ]; then
  echo "!! 缺少 packaging/internal/config.json" >&2
  exit 1
fi

echo "== 1/4 编译 App（双架构）=="
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/TaskPulse.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp packaging/Info.plist "$APP/Contents/Info.plist"
# 构建号用日期：App 自我安装时据此判断新旧，避免把旧副本盖到新版上
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VER" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

TMPB="$STAGE/build"
mkdir -p "$TMPB"
# swiftc 只允许 main.swift 写顶层代码
cp pulse.swift "$TMPB/main.swift"
for target in arm64 x86_64; do
  swiftc -O -target "$target-apple-macos13.0" -o "$TMPB/TaskPulse-$target" \
    "$TMPB/main.swift" onboarding.swift Bootstrap.swift -framework Cocoa
done
lipo -create -output "$APP/Contents/MacOS/TaskPulse" \
  "$TMPB/TaskPulse-arm64" "$TMPB/TaskPulse-x86_64"
chmod +x "$APP/Contents/MacOS/TaskPulse"

echo "== 2/4 把运行资源装进 Bundle =="
RES="$APP/Contents/Resources"
mkdir -p "$RES/vendor" "$RES/edge-ext"
cp poller.py "$RES/"
cp packaging/internal/config.json "$RES/"
[ -f packaging/internal/uv-args.txt ] && cp packaging/internal/uv-args.txt "$RES/"
# 扩展模板：config.js / manifest.json 由 App 首次启动时按配置生成，不进包
for f in "$PWD"/edge-ext/*; do
  case "$(basename "$f")" in config.js|manifest.json|*.bak*) continue ;; esac
  cp -R "$f" "$RES/edge-ext/"
done
# 配套脚本：小窗里的「扫码重新授权」、自查、卸载都指向安装目录里的这几个
cp packaging/api_login.command packaging/api_check.command \
   packaging/api_runtime.sh packaging/health_check.sh packaging/uninstall.command "$RES/"
chmod +x "$RES/api_login.command" "$RES/api_check.command" \
         "$RES/health_check.sh" "$RES/uninstall.command"
cp -R packaging/vendor/. "$RES/vendor/"
cp packaging/AppIcon.icns "$RES/"
echo "   -> 资源 $(du -sh "$RES" | cut -f1)"

echo "== 3/4 签名并校验 =="
# ad-hoc 签名：免费、无证书、无公证。系统首次会拦一次，由用户「仍要打开」放行；
# 这里不主动清 quarantine —— 保持 macOS 正常的放行流程。
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "   -> $(lipo -archs "$APP/Contents/MacOS/TaskPulse")"

echo "== 4/4 打包 =="
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R "$APP" "$OUT/"
codesign --verify --deep --strict "$OUT/TaskPulse.app"
cp packaging/QUICKSTART.md "$OUT/README.md"   # 英文名：中文名在某些解压工具里会乱码

ZIP="$NAME.zip"
( cd dist && rm -f "$ZIP" && zip -qry "$ZIP" "$NAME" )
echo "   -> dist/$ZIP ($(du -h "dist/$ZIP" | cut -f1))"
echo
unzip -l "dist/$ZIP" | sed -n '1,12p'
