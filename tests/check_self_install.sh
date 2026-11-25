#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || ! -x "$1" ]]; then
  echo "Usage: bash tests/check_self_install.sh /path/to/compiled/TaskPulse" >&2
  exit 2
fi
if [[ $(uname -s) != Darwin ]]; then
  echo "This smoke test requires a macOS graphical session." >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/taskpulse-install.XXXXXX")"
temp_dir="$(cd "$temp_dir" && pwd -P)"
ok_home="$temp_dir/Success O'Connor"
bad_home="$temp_dir/Failure"
ok_bundle="$temp_dir/Success Download/TaskPulse.app"
bad_bundle="$temp_dir/Failure Download/TaskPulse.app"
installed_bundle="$ok_home/Applications/TaskPulse.app"

bundle_pids() {
  local executable="$1/Contents/MacOS/TaskPulse"
  local pid command
  while read -r pid command; do
    case "$command" in
      "$executable"|"$executable "*) printf '%s\n' "$pid" ;;
    esac
  done < <(/bin/ps -axww -o pid= -o command=)
}

stop_bundle() {
  local bundle="$1" pid
  while read -r pid; do
    kill -TERM "$pid" 2>/dev/null || true
  done < <(bundle_pids "$bundle")
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    local file
    for file in "$ok_home/Library/Logs/taskpulse-app.log" "$bad_home/Library/Logs/taskpulse-app.log" \
      "$temp_dir"/{success,failure}.out; do
      if [[ -f "$file" ]]; then
        printf '\n--- %s ---\n' "$file" >&2
        tail -n 60 "$file" >&2
      fi
    done
  fi
  stop_bundle "$ok_bundle"
  stop_bundle "$bad_bundle"
  stop_bundle "$installed_bundle"
  rm -rf "$temp_dir"
  exit "$result"
}
trap cleanup EXIT

prepare_bundle() {
  local bundle="$1"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  cp "$repo_dir/packaging/Info.plist" "$bundle/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion 20261125" "$bundle/Contents/Info.plist"
  cp "$2" "$bundle/Contents/MacOS/TaskPulse"
  chmod +x "$bundle/Contents/MacOS/TaskPulse"
  # Omit poller resources so the App stops before installing any runtime dependency.
  codesign --force --sign - "$bundle"
  codesign --verify --strict "$bundle"
}

expect_log() {
  local app_log="$1" marker="$2" attempt
  for ((attempt = 0; attempt < 150; ++attempt)); do
    if [[ -f "$app_log" ]] && grep -Fq -- "$marker" "$app_log"; then
      return
    fi
    sleep 0.2
  done
  printf 'Timed out waiting for "%s" in %s\n' "$marker" "$app_log" >&2
  return 1
}

mkdir "$ok_home" "$bad_home"
prepare_bundle "$ok_bundle" "$1"
TP_HOME="$ok_home" "$ok_bundle/Contents/MacOS/TaskPulse" >"$temp_dir/success.out" 2>&1 &
ok_log="$ok_home/Library/Logs/taskpulse-app.log"
expect_log "$ok_log" "自我安装：已打开目标 App"
expect_log "$ok_log" "TaskPulse 界面已启动"
test -x "$installed_bundle/Contents/MacOS/TaskPulse"
codesign --verify --strict "$installed_bundle"
if [[ -z $(bundle_pids "$installed_bundle") ]]; then
  echo "Installed TaskPulse exited before startup could be verified." >&2
  exit 1
fi
stop_bundle "$installed_bundle"
echo "Self-install and installed App startup passed."

prepare_bundle "$bad_bundle" "$1"
# A regular file in place of the directory deterministically prevents installation.
touch "$bad_home/Applications"
TP_HOME="$bad_home" "$bad_bundle/Contents/MacOS/TaskPulse" >"$temp_dir/failure.out" 2>&1 &
bad_pid=$!
expect_log "$bad_home/Library/Logs/taskpulse-app.log" "自我安装失败"
if ! bundle_pids "$bad_bundle" | grep -Fxq -- "$bad_pid"; then
  echo "Installer exited instead of presenting its failure." >&2
  exit 1
fi
echo "Self-install failure keeps the installer running."
