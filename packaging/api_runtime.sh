# Load the API helpers' runtime from the same directory as the calling script.
UV=""
for candidate in "$HOME/.local/bin/uv" "$(command -v uv || true)" /opt/homebrew/bin/uv /usr/local/bin/uv; do
  if [ -x "$candidate" ]; then
    UV="$candidate"
    break
  fi
done
if [ -z "$UV" ]; then
  echo "!! 找不到 uv，请先打开 TaskPulse.app 完成初始化。" >&2
  return 1
fi

PY() { "$UV" run --quiet --no-project --python ">=3.10" python "$@"; }

resolved="$(PY - "$HOME/.taskpulse/runtime.json" "$UV" <<'PY'
import json
import os
import sys
from pathlib import Path

try:
    runtime = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, ValueError):
    runtime = {}
if not isinstance(runtime, dict):
    runtime = {}

configured = runtime.get("poller")
poller = Path(configured) if isinstance(configured, str) and os.path.isabs(configured) else None
if poller is None or not poller.is_file():
    # Also support the old installation layout and scripts run from the repo.
    poller = next((p.resolve() for p in (Path("poller.py"), Path("../poller.py")) if p.is_file()), None)
if poller is None:
    sys.exit(1)

uv = runtime.get("uv")
if not isinstance(uv, str) or not os.path.isabs(uv) or not os.path.isfile(uv) or not os.access(uv, os.X_OK):
    uv = sys.argv[2]

args = runtime.get("args")
if not isinstance(args, list) or not args or not all(isinstance(arg, str) and "\n" not in arg for arg in args):
    args = [
        "--with", "ks-aimate>=1.4.0",
        "--index", "https://pypi.corp.kuaishou.com/kuaishou/prod/+simple/",
    ]

print(poller)
print(uv)
for arg in args:
    print(arg)
PY
)" || {
  echo "!! 无法读取 TaskPulse 后台路径，请先打开 TaskPulse.app 完成初始化。" >&2
  return 1
}

{
  IFS= read -r POLLER_PATH
  IFS= read -r UV
  # The helpers import poller.py, so uv needs its inline script dependency explicitly.
  API_RUN=("$UV" run --quiet --no-project --python ">=3.10" --with 'requests>=2.31.0,<3')
  while IFS= read -r arg; do API_RUN+=("$arg"); done
} <<< "$resolved"
