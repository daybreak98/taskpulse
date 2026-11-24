#!/bin/bash
# TaskPulse 首次登录：API 模式需要一次扫码授权，之后长期可用。
# 用法：双击本脚本，用快手 App 扫屏幕上的二维码；成功后自动验证取数。
#
# 只依赖 macOS 自带的 curl / tar：扫码登录需要外部程序 agent-browser，
# 这里直接从 npm 取「平台二进制包」解压使用，不需要装 Node.js 或 npm。
set -uo pipefail
cd "$(dirname "$0")" || exit 1

CFG="$HOME/.taskpulse/config.json"
TOOLS="$HOME/.taskpulse/tools"
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV="$(command -v uv || true)"
AB_VERSION="0.44.0"

echo "== TaskPulse 首次登录 =="

if [ -z "$UV" ]; then
  echo "!! 找不到 uv（安装程序会自带）。请先双击 install.command，或用「重新打开安装引导」修复。"
  exit 1
fi

# 1) 找一个可用的 agent-browser：PATH 里已有的优先
if ! command -v agent-browser >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)  AB_PKG="cli-darwin-arm64" ;;
    x86_64) AB_PKG="cli-darwin-x64" ;;
    *)      echo "!! 不支持的 CPU 架构：${ARCH}"; exit 1 ;;
  esac

  if [ ! -x "$TOOLS/agent-browser" ]; then
    echo "-- 下载 agent-browser（约 9MB，仅首次）..."
    mkdir -p "$TOOLS"
    TMPD="$(mktemp -d)"
    URL="https://registry.npmjs.org/@agent-browser/${AB_PKG}/-/${AB_PKG}-${AB_VERSION}.tgz"
    if ! curl -sL -m 120 -o "$TMPD/ab.tgz" "$URL"; then
      echo "!! 下载失败：${URL}"
      rm -rf "$TMPD"
      exit 1
    fi
    if ! tar -xzf "$TMPD/ab.tgz" -C "$TMPD" 2>/dev/null; then
      echo "!! 解压失败，下载到的可能不是安装包"
      rm -rf "$TMPD"
      exit 1
    fi
    mv "$TMPD/package/bin/agent-browser" "$TOOLS/agent-browser" 2>/dev/null || {
      echo "!! 包里没找到 agent-browser"
      rm -rf "$TMPD"
      exit 1
    }
    chmod +x "$TOOLS/agent-browser"
    rm -rf "$TMPD"
    echo "-- 已就位：${TOOLS}/agent-browser"
  fi
  PATH="$TOOLS:$PATH"
  export PATH
fi
echo "-- agent-browser: $(agent-browser --version 2>&1 | head -1)"

echo
echo "接下来会打开一个浏览器窗口展示二维码，"
echo "用手机上的快手 App 扫码授权即可。二维码有效期约 1 分钟。"
echo
read -r -p "准备好了按回车开始..." _

rm -f "$HOME/.codeflicker/sso/.ks_sso/reauth.lock" 2>/dev/null
# 强制走浏览器登录：HTTP 重放这条路在首次登录时拿不到需要的 cookie，
# 直接跳过它，让 SDK 去展示二维码。
KS_SSO_DISABLE_HTTP_REPLAY=1 KS_SSO_BROWSER_CMD_TIMEOUT=180 \
"$UV" run --quiet --no-project --python ">=3.10" \
  --with 'ks-aimate>=1.4.0' \
  --index https://pypi.corp.kuaishou.com/kuaishou/prod/+simple/ \
  python - "$CFG" <<'PY'
import importlib.util, os, sys
os.environ["TASKPULSE_CONFIG"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("tp", "poller.py")
m = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(m)
    convs = m.AgentClient().conversations(10)
    print("RESULT OK %d" % len(convs))
except Exception as exc:
    print("RESULT FAIL %s: %s" % (type(exc).__name__, str(exc)[:120]))
PY

echo
if [ -f "$HOME/.codeflicker/sso/.ks_sso/sso-state.json" ]; then
  echo "凭据缓存：已生成。之后再跑 api_check.command 确认取数。"
else
  echo "凭据缓存：未生成（扫码可能没完成）。重跑本脚本即可。"
fi
