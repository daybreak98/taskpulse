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

# ---------- 2. 配置：包内自带就直接用，不再提问 ----------
mkdir -p "$HOME/.taskpulse"

# 团队内部包会把 config.json 放在安装包根目录（该文件不入库）
CFG_READY=0
if [ -f "./config.json" ]; then
  if [ -f "$CONFIG" ]; then
    BAK="$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CONFIG" "$BAK" && echo "-- 旧配置已备份：$BAK"
  fi
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
# 配套脚本都留一份到安装目录：用户以后自查、登录、卸载，都不必再找回当初解压的包
for f in uninstall.command health_check.sh api_check.command api_login.command; do
  [ -f "$f" ] && cp "$f" "$DEST/" && chmod +x "$DEST/$f"
done
# 去掉 Gatekeeper 隔离标记，避免「已损坏，无法打开」
xattr -dr com.apple.quarantine "$HOME/Applications/$APP_NAME.app" 2>/dev/null

# ---------- 3.5 本机接口密钥：生成并交给扩展 ----------
# poller / App / 浏览器扩展三方共用这一把钥匙。它只存在本机家目录里：
# 这里确保它存在（没有就现生成 32 字节 urlsafe base64，权限 0600），
# 值再写进扩展的 config.js。这样装完就能用，用户不用手动抄一遍密钥。
TOKEN_FILE="$HOME/.taskpulse/token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  OLD_UMASK="$(umask)"
  umask 077          # 生成期间别让同机其他账号读到
  if "$UV_BIN" run --quiet --no-project python - "$TOKEN_FILE" <<'PY'
import secrets, sys
with open(sys.argv[1], "w") as f:
    f.write(secrets.token_urlsafe(32) + "\n")
PY
  then
    echo "-- 已生成本机接口密钥：$TOKEN_FILE"
  else
    echo "!! 生成密钥失败，扩展和 App 会被本机服务拒绝（401）"
  fi
  umask "$OLD_UMASK"
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true
# 密钥里不会有空白，顺手把尾随换行去掉
TP_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE" 2>/dev/null || true)"
if [ -z "$TP_TOKEN" ]; then
  echo "!! 读不到本机接口密钥（$TOKEN_FILE）：扩展和 App 会被本机服务拒绝（401）"
  echo "   检查该文件是否可读，或删掉后重新运行本脚本"
fi

# ---------- 4. 把域名、端口和接口路径写进扩展（不声明 <all_urls>）----------
"$UV_BIN" run --quiet --no-project python - "$DEST/edge-ext" "$CONFIG" "$TP_PORT" "$TP_TOKEN" <<'PY'
import json, os, sys
d, cfg_path, port, token = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
cfg = json.load(open(cfg_path))
scope = (cfg.get("extension") or {}).get("scope") or ""
plat = cfg.get("platform") or {}

# 内容脚本在页面里取数时要用到的接口路径；同样是配置驱动，代码里不写死任何内部域名
body = {}
for k, v in (plat.get("conversations_body") or {}).items():
    body[k] = list(plat.get("agent_ids") or []) if v == "{agent_ids}" else v
eps = plat.get("endpoints") or {}
qf = plat.get("queue_fields") or {}
# 扩展与 poller 必须按同一套字段/路径解析：写死任何一处，换平台配置就会两边不一致
api = {
    "prefix": plat.get("api_prefix") or "",
    "conv": eps.get("conversations") or "",
    "queue": eps.get("queue") or "",
    "messages": eps.get("messages") or "",
    "state": qf.get("state") or "state",
    "pending": qf.get("pending") or "",
    "idle": list(qf.get("idle") or []),
    "body": body,
}

mpath = os.path.join(d, "manifest.json")
m = json.load(open(os.path.join(d, "manifest.template.json")))
# scope 同时给 host 权限：内容脚本（浏览器内取数）需要它才能注入页面
m["host_permissions"] = ["http://127.0.0.1:%d/*" % port] + ([scope] if scope else [])
json.dump(m, open(mpath, "w"), ensure_ascii=False, indent=2)

with open(os.path.join(d, "config.js"), "w") as f:
    f.write("// 由 install.command 按你的配置生成，重新安装会覆盖\n")
    # token 一起写进去：扩展请求本机服务时必须带 X-TP-Token，否则 poller 回 401
    f.write("self.TP_CONFIG = %s;\n" % json.dumps(
        {"scope": scope, "port": port, "token": token, "api": api if scope else None}))
print("   -> manifest.json / config.js")
PY
if [ -z "$TP_SCOPE" ]; then
  echo "-- 注意：extension.scope 为空，扩展装上也不会匹配任何页面"
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
    <string>$UV_BIN</string><string>run</string><string>--quiet</string><string>--python</string><string>&gt;=3.10</string>$UV_EXTRA_XML
    <string>$DEST/poller.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>AssociatedBundleIdentifiers</key><array><string>com.hyj.taskpulse</string></array>
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
  <key>AssociatedBundleIdentifiers</key><array><string>com.hyj.taskpulse</string></array>
  <key>StandardOutPath</key><string>$LOGS/taskpulse.stdout</string>
  <key>StandardErrorPath</key><string>$LOGS/taskpulse.stderr</string>
</dict>
</plist>
PLIST

# ---------- 6. 预热依赖（首次要联网装一次，提前跑完更省心）----------
echo "-- 检查运行依赖（首次会联网安装，约 30 秒）..."
UV_PREHEAT=()
if [ -f "./uv-args.txt" ]; then
  while IFS= read -r ARG; do
    [ -n "$ARG" ] && UV_PREHEAT+=("$ARG")
  done < ./uv-args.txt
fi
# bash 3.2（macOS 自带）在 set -u 下展开空数组会报错，分两条写
if [ ${#UV_PREHEAT[@]} -gt 0 ]; then
  "$UV_BIN" run --quiet --no-project --python ">=3.10" "${UV_PREHEAT[@]}" python -c "print('   -> 依赖就绪')" || {
    echo "!! 依赖安装失败（多见于公司网络未连内网）。装好后重跑本脚本即可。"
  }
else
  "$UV_BIN" run --quiet --no-project --python ">=3.10" python -c "print('   -> 依赖就绪')" || {
    echo "!! 依赖安装失败。装好后重跑本脚本即可。"
  }
fi

# ---------- 7. 启动 ----------
if [ "${TP_DRY:-}" = "1" ]; then
  echo "-- 干跑模式：跳过 launchctl / open"
  exit 0
fi

# 全新安装要让 App 弹一次浏览器扩展引导（bundle id 换过一次，两个都清）
defaults delete com.taskpulse.ui onboarded 2>/dev/null || true
defaults delete com.hyj.taskpulse onboarded 2>/dev/null || true

launchctl bootout "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.taskpulse.poller.plist" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.taskpulse.ui.plist" 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null

sleep 3
# 分别报告「进程在线」与「取数就绪」：服务返回 500 也算进程在线，
# 但那时候报「已就绪」会把人带进沟里
if [ -x "./health_check.sh" ]; then
  ./health_check.sh "${TP_PORT}"
  HC=$?
  case "$HC" in
    0) ;;
    2) echo "-- 服务在线，但取数还没就绪；页面/凭据就位后会自动开始" ;;
    *) echo "-- 后台服务没起来，看日志: ${LOGS}/taskpulse.poll.err" ;;
  esac
else
  echo "-- 缺少 health_check.sh，跳过健康检查"
fi

cat <<TIPS

===== 接下来只需 2 步（窗口里会带你走）=====
1) 屏幕中间会弹「装浏览器扩展」的引导：选 Edge 或 Chrome 后，它会自动
   打开扩展页、自动把扩展目录路径复制到剪贴板、自动在 Finder 里打开该目录。
   你只需要在扩展页里做两件事：
     a. 右上角打开「开发人员模式」
     b. 点「加载解压缩的扩展」→ 按 ⌘⇧G 粘贴路径 → 回车 → 选「选择」
   装好后引导会自己检测到，自动变成「已连接」，不用点任何检查按钮。

2) 首次点任务行跳转时，系统会弹「TaskPulse 想要控制浏览器」，点「允许」。
   数据服务用的是你浏览器里已登录的账号，不用另填 token。

扩展只读标签页标题与标签组名，只发 127.0.0.1；页面访问范围：${TP_SCOPE:-未配置}
扩展目录：$DEST/edge-ext

想重新走一遍引导：
  defaults delete com.taskpulse.ui onboarded; launchctl kickstart -k gui/$(id -u)/com.taskpulse.ui

想要卸载：运行 uninstall.command
TIPS
