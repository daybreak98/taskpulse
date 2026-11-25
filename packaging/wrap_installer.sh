#!/bin/bash
# 用已签名的 TaskPulse.app 生成可双击的独立安装器。
set -euo pipefail

payload="$1"
installer="$2"
contents="$installer/Contents"
plist="$contents/Info.plist"
plist_buddy=/usr/libexec/PlistBuddy

mkdir -p "$contents/MacOS" "$contents/Helpers" "$contents/Resources"
ditto "$payload" "$contents/Helpers/TaskPulse.app"
cp "$payload/Contents/MacOS/TaskPulse" "$contents/MacOS/TaskPulseInstaller"
cp "$(dirname "$0")/AppIcon.icns" "$contents/Resources/"
cp "$payload/Contents/Info.plist" "$plist"
"$plist_buddy" -c 'Set :CFBundleIdentifier com.hyj.taskpulse.installer' "$plist"
"$plist_buddy" -c 'Set :CFBundleExecutable TaskPulseInstaller' "$plist"
"$plist_buddy" -c 'Set :CFBundleName Install TaskPulse' "$plist"
"$plist_buddy" -c 'Set :CFBundleDisplayName Install TaskPulse' "$plist"
codesign --force --sign - "$installer"
codesign --verify --deep --strict "$installer"
