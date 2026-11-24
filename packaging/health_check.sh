#!/bin/bash
# 本机服务健康探针。用法：./health_check.sh [端口]（默认 8899）
#
# 为什么单独写这个脚本：install.command 原先只用 curl 的退出码判断「已就绪」，
# 而服务返回 HTTP 500 时那条命令照样返回 0，于是「进程活着」被误报成「能取数」。
# 这里把结论拆开，退出码含义：
#   0 = 取数就绪（HTTP 2xx 且结构完整、有采样时间、没有上游错误）
#   1 = 服务未响应 / HTTP 非 2xx / 返回结构不对（进程本身有问题）
#   2 = 服务在线，但取数未就绪（例如上游报错、还没采到第一份数据）
set -uo pipefail   # 不加 -e：curl 的非零退出是正常分支，要自己判断再给结论
PORT="${1:-8899}"
URL="http://127.0.0.1:$PORT/state"

if ! command -v curl >/dev/null 2>&1; then
  echo "结论：本机没有 curl，无法探测 ${URL}（退出码 1）"
  exit 1
fi

BODY="$(mktemp)" || exit 1
trap 'rm -f "$BODY"' EXIT

# --fail-with-body：HTTP >= 400 时返回非零（22），同时仍把响应体写进 $BODY，
# 这样既能判失败，又能在需要时把服务端错误原文带出来；--max-time 3 防止安装流程被卡死。
# stderr 丢掉，结论由本脚本自己拼成一行，避免 curl 的原始报错刷屏。
CODE="$(curl -sS --fail-with-body --max-time 3 -o "$BODY" -w '%{http_code}' "$URL" 2>/dev/null)"
RC=$?

if [ "$RC" -ne 0 ]; then
  case "$RC" in
    22) echo "结论：端口 $PORT 返回 HTTP ${CODE}（非 2xx），服务在报错（退出码 1）" ;;
    7)  echo "结论：端口 $PORT 没有服务在监听，进程未启动或已退出（退出码 1）" ;;
    28) echo "结论：端口 $PORT 3 秒内没有响应，服务卡住或被别的程序占用（退出码 1）" ;;
    52|56) echo "结论：端口 $PORT 连接被对端断开，上面大概不是 TaskPulse（退出码 1）" ;;
    *)  echo "结论：访问 ${URL} 失败（curl 退出码 ${RC}）（退出码 1）" ;;
  esac
  exit 1
fi

# curl 只把 >= 400 当失败，3xx 仍算成功，所以这里再卡一道 2xx
case "$CODE" in
  2*) : ;;
  *) echo "结论：${URL} 返回 HTTP ${CODE}，不是 2xx（退出码 1）"; exit 1 ;;
esac

# 结构校验优先用 python3（解析 JSON 比正则可靠）；没有可用的 python3 时退化成最保守的文本判断
if python3 -c '' >/dev/null 2>&1; then
  python3 - "$BODY" "$PORT" <<'PY'
import json, sys, time

path, port = sys.argv[1], sys.argv[2]
try:
    data = json.loads(open(path, "rb").read().decode("utf-8", "replace"))
except Exception:
    print("结论：端口 %s 有响应但不是 JSON，可能被别的程序占用（退出码 1）" % port)
    sys.exit(1)

if not isinstance(data, dict):
    print("结论：端口 %s 返回的 JSON 不是对象，结构不对（退出码 1）" % port)
    sys.exit(1)

# counts 与 updated 是视图的核心字段：缺了说明对面不是 TaskPulse 的 /state，
# updated 缺失算结构错误，而 updated 为 null 只说明还没采到数据，两者含义不同
for key in ("counts", "updated"):
    if key not in data:
        print("结论：/state 结构不对，缺少 %s 字段（退出码 1）" % key)
        sys.exit(1)
if not isinstance(data.get("counts"), dict):
    print("结论：/state 结构不对，counts 不是对象（退出码 1）")
    sys.exit(1)

err = data.get("poller_error")
if isinstance(err, str) and err.strip():
    # 原样打印上游错误，不改写：排障时要能直接拿这句话去搜日志
    print("结论：服务在线（端口 %s），但取数未就绪，上游报错：%s（退出码 2）" % (port, err))
    sys.exit(2)

updated = data.get("updated")
if not updated:
    print("结论：服务在线（端口 %s），但还没有首次采样，取数未就绪（退出码 2）" % port)
    sys.exit(2)

try:
    when = "采样于 %d 秒前" % max(0, int((time.time() * 1000 - float(updated)) / 1000))
except Exception:
    when = "采样时间 %s" % updated

counts = data["counts"]
parts = ["%s=%s" % (k, counts[k]) for k in ("running", "stuck", "attention", "done", "seen") if k in counts]
print("结论：就绪（端口 %s，%s，%s）（退出码 0）" % (port, when, ", ".join(parts) or "%d 项计数" % len(counts)))
sys.exit(0)
PY
  exit $?
fi

# 退化路径：没有 python3 时只判断字段是否出现，宁可保守也不要误报就绪
RAW="$(cat "$BODY")"
case "$RAW" in
  *'"counts"'*) : ;;
  *) echo "结论：/state 结构不对，缺少 counts 字段（退出码 1）"; exit 1 ;;
esac
case "$RAW" in
  *'"updated"'*) : ;;
  *) echo "结论：/state 结构不对，缺少 updated 字段（退出码 1）"; exit 1 ;;
esac
ERR="$(printf '%s' "$RAW" | sed -n 's/.*"poller_error": "\([^"]*\)".*/\1/p')"
if [ -n "$ERR" ]; then
  echo "结论：服务在线（端口 ${PORT}），但取数未就绪，上游报错：${ERR}（退出码 2）"
  exit 2
fi
case "$RAW" in
  *'"updated": null'*) echo "结论：服务在线（端口 ${PORT}），但还没有首次采样，取数未就绪（退出码 2）"; exit 2 ;;
esac
echo "结论：就绪（端口 ${PORT}，未安装 python3，仅做了字段级校验）（退出码 0）"
exit 0
