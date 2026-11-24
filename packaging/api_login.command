#!/bin/bash
# TaskPulse 首次登录：API 模式需要一次扫码授权，之后长期可用。
# 用法：双击本脚本，用快手 App 扫屏幕上的二维码；成功后自动验证取数。
set -uo pipefail
cd "$(dirname "$0")" || exit 1

CFG="$HOME/.taskpulse/config.json"
PORT=8899
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV="$(command -v uv || true)"
# agent-browser 是 SDK 用来打开登录页并展示二维码的后端，必须先就位
for d in "$HOME/.local/node/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

echo "== TaskPulse 首次登录 =="

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "-- 缺少 agent-browser，正在安装（约 10 秒）..."
  if ! command -v npm >/dev/null 2>&1; then
    echo "!! 没有 npm，装不了 agent-browser。请先安装 Node.js 后重跑本脚本。"
    exit 1
  fi
  npm install -g agent-browser >/dev/null 2>&1 || {
    echo "!! agent-browser 安装失败，请检查网络后重跑"
    exit 1
  }
  echo "-- agent-browser 已安装"
fi
echo "-- agent-browser: $(agent-browser --version 2>&1 | head -1)"

echo
echo "接下来会弹出一个浏览器窗口（或把二维码存成图片），"
echo "用手机上的快手 App 扫码授权即可。二维码有效期约 1 分钟。"
echo

read -r -p "准备好了按回车开始..." _

# 强制走浏览器登录：HTTP 重放路径在「首次登录」这一步拿不到需要的 cookie，
# 直接跳过它，让 SDK 去展示二维码。
rm -f "$HOME/.codeflicker/sso/.ks_sso/reauth.lock" 2>/dev/null
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
    print("OK %d" % len(convs))
except Exception as exc:
    print("FAIL %s: %s" % (type(exc).__name__, str(exc)[:120]))
PY

echo
if [ -f "$HOME/.codeflicker/sso/.ks_sso/sso-state.json" ]; then
  echo "凭据缓存：已生成"
else
  echo "凭据缓存：未生成（扫码没有完成？重跑本脚本即可）"
fi
echo "之后再跑 api_check.command 确认取数是否正常。"
