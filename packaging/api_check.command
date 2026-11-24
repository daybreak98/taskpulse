#!/bin/bash
# TaskPulse API 模式自检：逐项确认「进程直连接口」需要的东西是否就绪。
# 只读，不改任何文件。用法：./api_check.command
set -uo pipefail
cd "$(dirname "$0")" || exit 1

CFG="$HOME/.taskpulse/config.json"
PORT=8899
UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || UV="$(command -v uv || true)"

say() { printf '%-6s %s\n' "$1" "$2"; }

echo "== TaskPulse · API 模式自检 =="

# 1) 配置里是不是 module 认证
if [ -f "$CFG" ]; then
  PROVIDER="$("$UV" run --quiet --no-project --python ">=3.10" python - "$CFG" <<'PY' 2>/dev/null
import json,sys
c=json.load(open(sys.argv[1]))
a=c.get("auth") or {}
print(a.get("provider",""), (a.get("env") or {}).get("KS_AGENT_PLATFORM",""))
PY
)"
  set -- $PROVIDER
  say "配置" "provider=${1:-未知}  KS_AGENT_PLATFORM=${2:-未设置}"
else
  say "配置" "找不到 ${CFG}（先跑一次 install.command）"
fi

# 2) 内网源可达（依赖从这里装）
CODE="$(curl -s -o /dev/null -m 6 -w '%{http_code}' \
  https://pypi.corp.kuaishou.com/kuaishou/prod/+simple/ 2>/dev/null)"
if [ "$CODE" = "200" ] || [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  say "内网源" "可达（HTTP ${CODE}）"
else
  say "内网源" "不可达（HTTP ${CODE:-无响应}）→ 换不到依赖，API 模式起不来"
fi

# 3) 本机凭据服务（SDK 靠它换 ap-token）
CODE="$(curl -s -o /dev/null -m 4 -w '%{http_code}' \
  http://127.0.0.1:3459/api/open/ap-token 2>/dev/null)"
case "$CODE" in
  000|"") say "凭据服务" "127.0.0.1:3459 没有响应 → 先打开并登录 CodeFlicker / MyFlicker 客户端" ;;
  401|403) say "凭据服务" "在线但未授权（HTTP ${CODE}）→ 客户端里重新登录" ;;
  *)       say "凭据服务" "在线（HTTP ${CODE}）" ;;
esac

# 4) 用运行时的同一套参数，真的取一次数据
if [ -n "$UV" ]; then
  OUT="$("$UV" run --quiet --no-project --python ">=3.10" \
    --with 'ks-aimate>=1.0.29' \
    --index https://pypi.corp.kuaishou.com/kuaishou/prod/+simple/ \
    python - "$CFG" <<'PY' 2>&1 | tail -3
import importlib.util, os, sys
os.environ["TASKPULSE_CONFIG"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("tp", "poller.py")
m = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(m)
    agent = m.AgentClient()
    convs = agent.conversations(8)
    print("OK 取到 %d 个会话（源=%s）" % (len(convs), m.source_mode()))
except Exception as exc:
    print("FAIL %s: %s" % (type(exc).__name__, exc))
PY
)"
  say "直接取数" "$OUT"
fi

# 5) 常驻服务本身
if [ -x "./health_check.sh" ]; then
  ./health_check.sh "$PORT"
else
  echo "（缺少 health_check.sh，跳过）"
fi

echo
echo "对应处理："
echo "  内网源不可达      → 连上内网/VPN 后重跑 install.command"
echo "  凭据服务没响应    → 打开 CodeFlicker / MyFlicker 客户端并登录，再等 10 秒重跑本脚本"
echo "  直接取数 FAIL 401 → 客户端登录态过期，重新登录"
echo "  都正常但界面空    → 看 ~/Library/Logs/taskpulse.log 里最后一条「取数失败」"
echo "  实在不行先用 WEB   → 展开浮窗点 WEB，不需要任何凭据"
