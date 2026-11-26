#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/taskpulse-bootstrap.XXXXXX")"
tmp="$(cd "$tmp" && pwd -P)"
home="$tmp/home"
bundle="$home/Applications/TaskPulse.app"
exe="$bundle/Contents/MacOS/TaskPulse"
res="$bundle/Contents/Resources"
ext="$home/Applications/TaskPulse/edge-ext"
server_pid=
app_pids() {
  local pid command
  while read -r pid command; do
    case "$command" in "$exe"|"$exe "*) printf '%s\n' "$pid";; esac
  done < <(/bin/ps -axww -o pid= -o command=)
}
stop_app() {
  local pid i
  while read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done < <(app_pids)
  for ((i=0;i<50;i++)); do
    if [[ -z "$(app_pids)" ]]; then return; fi
    sleep 0.1
  done
  echo "fixture App failed to exit" >&2
  return 1
}
cleanup() {
  local result=$?
  trap - EXIT
  if ((result != 0)); then
    tail -n 60 "$home/Library/Logs/taskpulse-app.log" 2>/dev/null || true
    echo "bootstrap fixture failed" >&2
  fi
  stop_app || true
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
  exit "$result"
}
trap cleanup EXIT
mkdir -p "$res/edge-ext" "$(dirname "$exe")" "$home/.local/bin"
cp "$repo/packaging/Info.plist" "$bundle/Contents/Info.plist"
cp "$1" "$exe"
chmod +x "$exe"
# The mock HTTP backend already runs on the configured port. The fake uv only
# serves dependency checks; no runtime or network install is performed.
printf '#!/bin/bash\nexit 0\n' >"$home/.local/bin/uv"
chmod +x "$home/.local/bin/uv"
printf '# fixture backend\n' >"$res/poller.py"
for name in background.js web-bridge.js manifest.template.json; do
  cp "$repo/edge-ext/$name" "$res/edge-ext/$name"
done
python3 -u - "$tmp" "$home" <<'PY' &
import json, pathlib, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root, home = map(pathlib.Path, sys.argv[1:])
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path != "/state":
            self.send_error(404)
            return
        try:
            token = (home / ".taskpulse/token").read_text().strip()
        except OSError:
            token = ""
        if not token or self.headers.get("X-TP-Token") != token:
            self.send_error(401)
            return
        with (root / "requests").open("a") as f:
            f.write("authenticated state\n")
        payload = json.dumps({"updated": int(time.time()*1000), "source":"web",
                    "tasks":[], "active":[], "all":[],
                    "counts":{"running":0,"stuck":0,"attention":0,"done":0}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(root / "port").write_text(str(server.server_port))
server.serve_forever()
PY
server_pid=$!
for ((i=0;i<50;i++)); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"
python3 - "$res/config.json" "$port" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"ui":{"port":sys.argv[2]}, "source":"web",
        "extension":{"scope":"https://agent.example.com/*"},
        "platform":{"base_url":"https://agent.example.com","conversation_url":"{host}/chat?conversationId={cid}",
                    "endpoints":{"conversations":"/list","queue":"/queue/{cid}"}}}, f)
PY
codesign --force --sign - "$bundle" >/dev/null
codesign --verify --strict "$bundle"
wait_startup() {
  local i
  for ((i=0;i<125;i++)); do
    if [[ -s "$home/.taskpulse/runtime.json" && -s "$ext/manifest.json" && -f "$tmp/requests" ]] &&
       [[ $(wc -l <"$tmp/requests") -ge 3 ]]; then return; fi
    sleep 0.2
  done
  echo "Expected three authenticated App /state requests on the configured port" >&2
  return 1
}
assert_files() {
  local name
  for name in background.js web-bridge.js manifest.template.json; do
    cmp "$res/edge-ext/$name" "$ext/$name"
  done
  python3 - "$home" "$res" "$port" <<'PY'
import json, pathlib, sys
home, res = map(pathlib.Path, sys.argv[1:3]); port = int(sys.argv[3])
state = home / ".taskpulse"
runtime = json.loads((state / "runtime.json").read_text())
assert runtime["port"] == port, runtime
assert runtime["poller"] == str(res / "poller.py"), runtime
ext = home / "Applications/TaskPulse/edge-ext"
config = json.loads((ext / "config.js").read_text().split("self.TP_CONFIG = ",1)[1].strip().rstrip(";"))
assert config["port"] == port
assert config["token"] == (state / "token").read_text().strip()
manifest = json.loads((ext / "manifest.json").read_text())
template = json.loads((res / "edge-ext/manifest.template.json").read_text())
assert manifest["permissions"] == template["permissions"]
assert manifest["host_permissions"] == [f"http://127.0.0.1:{port}/*","https://agent.example.com/*"]
PY
}
/usr/bin/open -n --env "TP_HOME=$home" "$bundle"
wait_startup
assert_files
cp "$home/.taskpulse/config.json" "$tmp/original-config"
cp "$home/.taskpulse/token" "$tmp/original-token"
stop_app
echo "Fresh App launch uses the configured port and bridge."
# Simulate an installed previous version: same directory, stale scripts,
# stale generated configuration, and old runtime pointer/port.
printf 'old poller\n' >"$tmp/old-poller.py"
python3 - "$home/.taskpulse/runtime.json" "$tmp/old-poller.py" <<'PY'
import json, sys
p=sys.argv[1]
with open(p) as f: data=json.load(f)
data.update(poller=sys.argv[2],port=8899)
with open(p,"w") as f: json.dump(data,f)
PY
for name in background.js web-bridge.js manifest.template.json config.js manifest.json; do
  printf 'old %s\n' "$name" >"$ext/$name"
done
: >"$tmp/requests"
/usr/bin/open -n --env "TP_HOME=$home" "$bundle"
wait_startup
assert_files
cmp "$tmp/original-config" "$home/.taskpulse/config.json"
cmp "$tmp/original-token" "$home/.taskpulse/token"
stop_app
echo "Initialized App restart refreshes stale bridge and runtime without losing settings."
