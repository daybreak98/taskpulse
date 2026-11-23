#!/bin/bash
# TaskPulse 安装脚本：双击运行即可（不需要 sudo）
set -uo pipefail
cd "$(dirname "$0")" || exit 1

APP_NAME="TaskPulse"
DEST="$HOME/Applications/$APP_NAME"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
CONFIG="$HOME/.taskpulse/config.json"

echo "== TaskPulse 安装 =="
echo "目标目录: $DEST"

# ---------- 1. 准备 uv（用于运行后台服务）----------
UV_BIN="$(command -v uv || true)"
if [ -z "$UV_BIN" ]; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    UV_BIN="$HOME/.local/bin/uv"
  else
    echo "-- 未找到 uv，正在安装（需要网络）..."
    curl -LsSf https://astral.sh/uv/install.sh | sh || {
      echo "!! uv 安装失败，请手动安装后重试：https://docs.astral.sh/uv/"
      exit 1
    }
    UV_BIN="$HOME/.local/bin/uv"
  fi
fi
echo "-- uv: $UV_BIN"

# ---------- 2. 配置：包内带配置就沿用，否则问三个问题 ----------
mkdir -p "$HOME/.taskpulse"

# 团队内部包会把 config.json 放在安装包根目录（该文件不入库）
CFG_READY=0
if [ ! -f "$CONFIG" ] && [ -f "./config.json" ]; then
  cp "./config.json" "$CONFIG"
  echo "-- 使用安装包内自带的配置：$CONFIG"
  CFG_READY=1
fi

if [ -f "$CONFIG" ]; then
  [ "$CFG_READY" = "1" ] || echo "-- 已有配置，沿用：$CONFIG"
else
  echo
  echo "===== 首次配置（3 步；直接回车就用方括号里的默认值）====="

  TP_BASE_URL=""
  TP_AGENT=""
  while [ -z "$TP_BASE_URL" ]; do
    echo
    echo "1) 会话页链接"
    echo "   浏览器里打开任意一个会话，把地址栏那一整串贴到这里。"
    printf "   > "
    read -r RAW_URL
    # 从链接里抠出「协议 + 域名」和 agentId
    TP_BASE_URL=$(printf '%s' "$RAW_URL" | sed -nE 's#^[[:space:]]*(https?://[^/?#]+).*#\1#p')
    if [ -z "$TP_AGENT" ]; then
      TP_AGENT=$(printf '%s' "$RAW_URL" | sed -nE 's#.*[?&]agentId=([0-9]+).*#\1#p')
    fi
    if [ -z "$TP_BASE_URL" ]; then
      echo "   !! 没认出域名，请粘贴完整链接（要带 https://）；也可以直接输入域名，如 https://agent.example.com"
    fi
  done

  if [ -z "$TP_AGENT" ]; then
    printf "   agentId（链接里没有，请手填，例如 1001）: "
    read -r TP_AGENT
  fi
  echo "   域名: $TP_BASE_URL    agentId: ${TP_AGENT:-（空）}"

  echo
  printf "2) API 前缀 [/api/v1]: "
  read -r TP_PREFIX
  TP_PREFIX="${TP_PREFIX:-/api/v1}"
  case "$TP_PREFIX" in /*) ;; *) TP_PREFIX="/$TP_PREFIX" ;; esac

  echo
  echo "3) 服务怎么认证？"
  echo "   1) 令牌文件（把 token 写进一个文件，脚本每次请求时读）"
  echo "   2) 不需要认证"
  printf "   选 [1]: "
  read -r AUTH_CHOICE
  AUTH_CHOICE="${AUTH_CHOICE:-1}"
  if [ "$AUTH_CHOICE" = "1" ]; then
    printf "   令牌文件路径 [~/.taskpulse/token]: "
    read -r TP_TOKEN_FILE
    TP_TOKEN_FILE="${TP_TOKEN_FILE:-~/.taskpulse/token}"
    TP_PROVIDER="token_file"
    if [ ! -s "$(eval echo "$TP_TOKEN_FILE")" ]; then
      echo "   -- 提示：这个文件还不存在或为空，取数会报错；稍后把令牌写进去即可。"
    fi
  else
    TP_PROVIDER="none"
    TP_TOKEN_FILE=""
  fi

  printf "   端口 [8899]: "
  read -r TP_PORT
  TP_PORT="${TP_PORT:-8899}"

  TP_AGENT_JSON="[]"
  [ -n "$TP_AGENT" ] && TP_AGENT_JSON="[$TP_AGENT]"

  cat > "$CONFIG" <<JSON
{
  "platform": {
    "base_url": "$TP_BASE_URL",
    "api_prefix": "$TP_PREFIX",
    "agent_ids": $TP_AGENT_JSON,
    "conversation_url": "{host}/chat?agentId={agent}&conversationId={cid}",
    "endpoints": {
      "conversations": "/conversations/list",
      "queue": "/conversations/{cid}/queue",
      "messages": "/conversations/{cid}/messages?pageNo=1&pageSize=1"
    },
    "conversations_body": {
      "session_list": "{agent_ids}",
      "page": 1,
      "size": 60
    },
    "queue_fields": {"state": "state", "pending": "pending", "idle": ["IDLE"]},
    "messages_list_key": "list"
  },
  "auth": {
    "provider": "$TP_PROVIDER",
    "module": "",
    "factory": "Session",
    "extra_config": {},
    "ctor_kwargs": {},
    "token_file": "$TP_TOKEN_FILE",
    "token_header": "Authorization",
    "token_prefix": "Bearer "
  },
  "poll": {
    "interval_seconds": 60,
    "watch_limit": 20,
    "stuck_seconds": 1800,
    "window_limit": 10,
    "archive_hours": 48
  },
  "ui": {"port": $TP_PORT},
  "extension": {"scope": "$TP_BASE_URL/*"},
  "failure_marks": []
}
JSON
  echo
  echo "-- 配置已写入 $CONFIG"
  echo "   接口路径、请求体字段、判定「卡住」的时间等都在这份文件里，可以随时改。"
fi

# 从配置里取出端口和扩展域名（用 uv 带的 python 解析，保证 JSON 合法）
CFG_OUT="$("$UV_BIN" run --quiet --no-project python - "$CONFIG" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("ui", {}).get("port", 8899), d.get("extension", {}).get("scope", ""))
PY
)"
TP_PORT="$(printf '%s' "$CFG_OUT" | awk '{print $1}')"
TP_SCOPE="$(printf '%s' "$CFG_OUT" | awk '{$1=""; sub(/^ /,""); print}')"
TP_PORT="${TP_PORT:-8899}"
echo "-- 端口: $TP_PORT    扩展域名: ${TP_SCOPE:-（未配置）}"

# ---------- 3. 拷贝文件 ----------
mkdir -p "$HOME/Applications" "$DEST" "$LOGS" "$AGENTS"
rm -rf "$HOME/Applications/$APP_NAME.app"
cp -R "$APP_NAME.app" "$HOME/Applications/" || { echo "!! 拷贝 App 失败"; exit 1; }
cp poller.py "$DEST/"
rm -rf "$DEST/edge-ext"
cp -R edge-ext "$DEST/"
# 去掉 Gatekeeper 隔离标记，避免「已损坏，无法打开」
xattr -dr com.apple.quarantine "$HOME/Applications/$APP_NAME.app" 2>/dev/null

# ---------- 4. 把域名和端口写进扩展（不声明 <all_urls>）----------
if [ -n "$TP_SCOPE" ]; then
  "$UV_BIN" run --quiet --no-project python - "$DEST/edge-ext" "$TP_SCOPE" "$TP_PORT" <<'PY'
import json, os, sys
d, scope, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
mpath = os.path.join(d, "manifest.json")
m = json.load(open(mpath))
m["host_permissions"] = ["http://127.0.0.1:%d/*" % port]
json.dump(m, open(mpath, "w"), ensure_ascii=False, indent=2)
with open(os.path.join(d, "config.js"), "w") as f:
    f.write("// 由 install.command 按你的配置生成，重新安装会覆盖\n")
    f.write("self.TP_CONFIG = %s;\n" % json.dumps({"scope": scope, "port": port}))
print("   -> manifest.json / config.js")
PY
else
  echo "-- 跳过：extension.scope 为空，扩展装上也不会匹配任何页面"
  "$UV_BIN" run --quiet --no-project python - "$DEST/edge-ext" "$TP_PORT" <<'PY'
import json, os, sys
d, port = sys.argv[1], int(sys.argv[2])
mpath = os.path.join(d, "manifest.json")
m = json.load(open(mpath))
m["host_permissions"] = ["http://127.0.0.1:%d/*" % port]
json.dump(m, open(mpath, "w"), ensure_ascii=False, indent=2)
with open(os.path.join(d, "config.js"), "w") as f:
    f.write("// 由 install.command 按你的配置生成，重新安装会覆盖\n")
    f.write("self.TP_CONFIG = %s;\n" % json.dumps({"scope": "", "port": port}))
PY
fi

# ---------- 5. 写入 launchd 配置 ----------
# 团队内部包可能带 uv-args.txt（每行一个额外参数，如 --with 内部包 --index 私有源）
UV_EXTRA_XML=""

if [ -f "./uv-args.txt" ]; then
  while IFS= read -r ARG; do
    [ -z "$ARG" ] && continue
    ARG="$(printf '%s' "$ARG" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
    UV_EXTRA_XML="$UV_EXTRA_XML<string>$ARG</string>"
  done < ./uv-args.txt
fi

cat > "$AGENTS/com.taskpulse.poller.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.taskpulse.poller</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV_BIN</string><string>run</string><string>--quiet</string>$UV_EXTRA_XML
    <string>$DEST/poller.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/taskpulse.poll.out</string>
  <key>StandardErrorPath</key><string>$LOGS/taskpulse.poll.err</string>
</dict>
</plist>
PLIST

cat > "$AGENTS/com.taskpulse.ui.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.taskpulse.ui</string>
  <key>ProgramArguments</key>
  <array><string>$HOME/Applications/$APP_NAME.app/Contents/MacOS/$APP_NAME</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/taskpulse.stdout</string>
  <key>StandardErrorPath</key><string>$LOGS/taskpulse.stderr</string>
</dict>
</plist>
PLIST

# ---------- 6. 启动 ----------
if [ "${TP_DRY:-}" = "1" ]; then
  echo "-- 干跑模式：跳过 launchctl / open"
  exit 0
fi

launchctl bootout "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.taskpulse.poller.plist" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.taskpulse.ui.plist" 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null

sleep 3
if curl -s -m 2 "http://127.0.0.1:$TP_PORT/state" >/dev/null; then
  echo "-- 后台服务已就绪 (http://127.0.0.1:$TP_PORT/state)"
else
  echo "-- 后台服务还没起来，看日志: $LOGS/taskpulse.poll.err"
fi

open -R "$HOME/Applications/$APP_NAME.app" 2>/dev/null

cat <<TIPS

===== 还需要手动完成的 2 步 =====
1) 浏览器扩展
   打开 Edge -> edge://extensions -> 打开「开发人员模式」-> 「加载解压缩的扩展」
   选择目录：$DEST/edge-ext
   （扩展只上报标签页标题与组名，只允许访问 127.0.0.1；页面访问范围：${TP_SCOPE:-未配置}）

2) 首次授权
   第一次点任务行跳转时，系统会弹「TaskPulse 想要控制 Microsoft Edge」，点「允许」。
   若服务需要登录，按日志提示完成一次即可。

想要卸载：运行 uninstall.command
TIPS
