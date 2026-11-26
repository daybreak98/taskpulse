#!/bin/bash
# TaskPulse 一键自检 + 自愈：跑一次，能自动修的修掉，最后只留一句结论。
# 只读配置；必要时会切换数据来源（api ↔ web）。用法：双击，或 ./api_check.command
set -uo pipefail
cd "$(dirname "$0")" || exit 1

CFG="$HOME/.taskpulse/config.json"
TOKEN_FILE="$HOME/.taskpulse/token"
WEBSTATE="$HOME/.taskpulse/webstate.json"

. ./api_runtime.sh || exit 1

# 端口必须来自实际配置：当前后台就是按这份配置监听的
PORT="$(PY -c '
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("ui", {}).get("port") or 8899)
except Exception:
    print(8899)
' "$CFG" 2>/dev/null)"

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

TARGET_DOMAIN="$(PY -c '
import json, sys
from urllib.parse import urlparse
try:
    host = urlparse(json.load(open(sys.argv[1]))["platform"]["base_url"]).netloc
except Exception:
    host = ""
print(host)
' "$CFG" 2>/dev/null)"
TOKEN_URL=""
for port in 3459 3469 3479; do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:${port}/api/open/ap-token" 2>/dev/null; then
    TOKEN_URL="http://127.0.0.1:${port}/api/open/ap-token"
    break
  fi
done
[ -z "$TOKEN_URL" ] && TOKEN_URL="http://127.0.0.1:3459/api/open/ap-token"
say "凭据服务" "$(printf '%s' "$TOKEN_URL" | sed 's|.*//||; s|/api.*||')"

IDENT="$(curl -s -m 4 "${TOKEN_URL}?trustDomain=${TARGET_DOMAIN}" 2>/dev/null | PY -c '
import sys, json, base64
try:
    d = json.load(sys.stdin)
    t = (d.get("data") or {}).get("accessToken") or ""
    p = t.split(".")[1]; p += "=" * (-len(p) % 4)
    i = json.loads(base64.urlsafe_b64decode(p))
    aud = ",".join(i.get("aud") or []) or "-"
    print("%s %s %s" % (i.get("username") or "-", i.get("claw_id_issuer") or "-", aud))
except Exception:
    print("? ?")
' 2>/dev/null)"
USER_NAME="$(printf '%s' "$IDENT" | awk '{print $1}')"
ISSUER="$(printf '%s' "$IDENT" | awk '{print $2}')"
AUD="$(printf '%s' "$IDENT" | awk '{print $3}')"
SDK_VER="$("${API_RUN[@]}" \
  python -c 'from importlib.metadata import version; print(version("ks_aimate"))' 2>/dev/null | tail -1)"
say "客户端" "${APP}（票据签发方 ${ISSUER}）"
say "登录账号" "${USER_NAME}"
say "SDK" "ks-aimate ${SDK_VER:-未知}"
say "票据范围" "${AUD}（目标域 ${TARGET_DOMAIN}，SDK 实际使用的那张）"

SSO_STATE="${HOME}/.codeflicker/sso/.ks_sso/sso-state.json"
COOKIES="$(PY -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(len(d.get("cookies") or []))
except Exception:
    print(0)
' "$SSO_STATE" 2>/dev/null)"
say "登录凭据" "${COOKIES} 条 cookie（${SSO_STATE}）"
# 票的 aud 里没有目标域名 → 换到的是普通票，数据平台会以 401 拒掉
if [ -n "$AUD" ] && [ "$AUD" != "-" ]; then
  case "$AUD" in
    *dataagent*) : ;;
    *) say "注意" "票据不含 dataagent 域，SDK 版本偏低会导致此现象（需 >=1.4.0）" ;;
  esac
fi

# ── 1.5 配置项 & 目标域名连通性 ────────────────────────────────
# 平台变量为空时 SDK 会静默跳过换票，表现也是 401；接口域名和 pypi 源不是同一台
# 机器，内网源通不代表接口通，所以两者单独探。
CFG_AUDIT="$(PY -c '
import json, sys
try:
    a = (json.load(open(sys.argv[1])).get("auth") or {})
    print("%s|%s" % (a.get("provider") or "-", (a.get("env") or {}).get("KS_AGENT_PLATFORM") or ""))
except Exception:
    print("-|")
' "$CFG" 2>/dev/null)"
say "配置" "provider=${CFG_AUDIT%%|*}  KS_AGENT_PLATFORM=${CFG_AUDIT##*|}"
case "${CFG_AUDIT##*|}" in
  "") say "注意" "KS_AGENT_PLATFORM 为空，SDK 会跳过换票，API 模式必然失败" ;;
esac

CODE="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "https://${TARGET_DOMAIN}/" 2>/dev/null)"
case "$CODE" in
  000|"") say "接口域名" "${TARGET_DOMAIN} 无响应（内网或 VPN？）" ;;
  *)      say "接口域名" "${TARGET_DOMAIN} 可达（HTTP ${CODE}）" ;;
esac

# ── 2. 直连取数（和常驻服务完全同一套参数）────────────────────────
RESULT="$("${API_RUN[@]}" python - "$CFG" "$POLLER_PATH" <<'PY' 2>&1 | tail -1
import importlib.util, os, sys
os.environ["TASKPULSE_CONFIG"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("tp", sys.argv[2])
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

# 切换来源并回读确认：POST 成功不代表配置真的改了（评审复现过误报）
switch_to() {
  api "/mode?value=$1" "-X POST" >/dev/null 2>&1
  api "/mode" 2>/dev/null | PY -c '
import json, sys
try:
    print(json.load(sys.stdin).get("source") or "")
except Exception:
    print("")
' 2>/dev/null
}

if [ "$CASE" = "OK" ]; then
  NOW="$(switch_to api)"
  if [ "$NOW" = "api" ]; then
    ./health_check.sh "$PORT" 2>/dev/null | tail -1
    say "结论" "API 模式可用（取到 ${DETAIL} 个会话），数据源已确认切换为 api。"
  else
    say "结论" "API 取数可用，但切换数据源未生效（当前 ${NOW:-未知}），请手动点 WEB/API 再试。"
  fi
  exit 0
fi

# ── 3b. API 不可用：自动切 WEB，让它立刻能用 ──────────────────────
NOW="$(switch_to web)"
FRESH="$(PY -c '
import json, sys, time
try:
    at = json.load(open(sys.argv[1])).get("at") or 0
except Exception:
    at = 0
print("yes" if at and (time.time() * 1000 - at) < 180000 else "no")
' "$WEBSTATE" 2>/dev/null)"

case "$DETAIL" in
  *401*)
    if [ "${COOKIES:-0}" -lt 5 ]; then
      WHY="本机没有登录凭据（cookie=${COOKIES}），需要扫码授权一次"
    else
      WHY="登录凭据已过期或账号无权限（账号 ${USER_NAME}），重跑 api_login.command 可续期"
    fi ;;
  *403*)  WHY="账号 ${USER_NAME} 没有该接口权限" ;;
  *ModuleNotFoundError*) WHY="依赖没装上（内网源不通）" ;;
  *Connection*|*Timeout*|*timed*) WHY="连不上数据平台（网络）" ;;
  *)      WHY="${DETAIL}" ;;
esac
say "API" "不可用：${WHY}"
if [ "$NOW" = "web" ]; then
  say "已切到" "WEB（不需要任何凭据）"
else
  say "切换失败" "没能把数据源改到 WEB（当前 ${NOW:-未知}），请在浮窗里点一下 WEB"
fi

if [ "$FRESH" = "yes" ]; then
  say "结论" "现在就能用：浮窗里已经有数据。"
else
  say "结论" "已切到 WEB。打开任意一个 DataAgent 页面即可开始，其余不用管。"
fi
echo
if [ "${COOKIES:-0}" -lt 5 ]; then
  echo "想用 API 模式：双击同目录的 api_login.command，用快手 App 扫码授权一次（约 30 秒），之后长期可用。"
else
  echo "想用回 API 只需一步：在 ${APP} 里退出登录，用你自己的内网账号重登，然后重跑本脚本。"
fi
exit 0
