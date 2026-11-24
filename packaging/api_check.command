#!/bin/bash
# TaskPulse 一键自检 + 自愈：跑一次，能自动修的修掉，最后只留一句结论。
# 只读配置；必要时会切换数据来源（api ↔ web）。用法：双击，或 ./api_check.command
set -uo pipefail
cd "$(dirname "$0")" || exit 1

CFG="$HOME/.taskpulse/config.json"
TOKEN_FILE="$HOME/.taskpulse/token"
WEBSTATE="$HOME/.taskpulse/webstate.json"
PORT=8899
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV="$(command -v uv || true)"
PY() { "$UV" run --quiet --no-project --python ">=3.10" python "$@"; }

say() { printf '%-8s %s\n' "$1" "$2"; }
api() { curl -s -m 4 -H "X-TP-Token: $(cat "$TOKEN_FILE" 2>/dev/null)" "http://127.0.0.1:${PORT}$1" ${2:-} 2>/dev/null; }

echo "== TaskPulse 自检 =="

# ── 0. 服务在不在 ────────────────────────────────────────────────
if ! api /mode >/dev/null 2>&1; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.taskpulse.poller.plist" 2>/dev/null
  launchctl kickstart -k "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
  sleep 5
  if ! api /mode >/dev/null 2>&1; then
    say "服务" "没起来，看 ~/Library/Logs/taskpulse.poll.err"
    exit 1
  fi
  say "服务" "原本没在跑，已拉起"
fi

# ── 1. 客户端与账号 ─────────────────────────────────────────────
APP="$(ps -Ao command | grep -iE "/(MyFlicker|CodeFlicker)\.app/Contents/MacOS/" | grep -v grep | head -1 | sed 's|.*/\([^/]*\)\.app/.*|\1|')"
[ -z "$APP" ] && APP="未运行"

IDENT="$(curl -s -m 4 http://127.0.0.1:3459/api/open/ap-token 2>/dev/null | PY -c '
import sys, json, base64
try:
    d = json.load(sys.stdin)
    t = (d.get("data") or {}).get("accessToken") or ""
    p = t.split(".")[1]; p += "=" * (-len(p) % 4)
    i = json.loads(base64.urlsafe_b64decode(p))
    print("%s %s" % (i.get("username") or "-", i.get("claw_id_issuer") or "-"))
except Exception:
    print("? ?")
' 2>/dev/null)"
USER_NAME="${IDENT%% *}"
ISSUER="${IDENT##* }"
say "客户端" "${APP}（票据签发方 ${ISSUER}）"
say "登录账号" "${USER_NAME}"

# ── 2. 直连取数（和常驻服务完全同一套参数）────────────────────────
RESULT="$("$UV" run --quiet --no-project --python ">=3.10" \
  --with 'ks-aimate>=1.0.29' \
  --index https://pypi.corp.kuaishou.com/kuaishou/prod/+simple/ \
  python - "$CFG" <<'PY' 2>&1 | tail -1
import importlib.util, os, sys
os.environ["TASKPULSE_CONFIG"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("tp", "poller.py")
m = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(m)
    convs = m.AgentClient().conversations(8)
    print("OK %d" % len(convs))
except Exception as exc:
    print("FAIL %s: %s" % (type(exc).__name__, str(exc)[:80]))
PY
)"
CASE="${RESULT%% *}"
DETAIL="${RESULT#* }"

if [ "$CASE" = "OK" ]; then
  api "/mode?value=api" "-X POST" >/dev/null
  ./health_check.sh "$PORT" 2>/dev/null | tail -1
  say "结论" "API 模式可用（取到 ${DETAIL} 个会话）。数据源已设为 api，不用再操作。"
  exit 0
fi

# ── 3b. API 不可用：自动切 WEB，让它立刻能用 ──────────────────────
api "/mode?value=web" "-X POST" >/dev/null
FRESH="$(PY -c '
import json, sys, time
try:
    at = json.load(open(sys.argv[1])).get("at") or 0
except Exception:
    at = 0
print("yes" if at and (time.time() * 1000 - at) < 180000 else "no")
' "$WEBSTATE" 2>/dev/null)"

case "$DETAIL" in
  *401*)  WHY="票据被数据平台拒绝（账号 ${USER_NAME}）" ;;
  *403*)  WHY="账号 ${USER_NAME} 没有该接口权限" ;;
  *ModuleNotFoundError*) WHY="依赖没装上（内网源不通）" ;;
  *Connection*|*Timeout*|*timed*) WHY="连不上数据平台（网络）" ;;
  *)      WHY="${DETAIL}" ;;
esac
say "API" "不可用：${WHY}"
say "已切到" "WEB（不需要任何凭据）"

if [ "$FRESH" = "yes" ]; then
  say "结论" "现在就能用：浮窗里已经有数据。"
else
  say "结论" "已切到 WEB。打开任意一个 DataAgent 页面即可开始，其余不用管。"
fi
echo
echo "想用回 API 只需一步：在 ${APP} 里退出登录，用你自己的内网账号重登，然后重跑本脚本。"
exit 0
