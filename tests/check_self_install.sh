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
upgrade_bundle="$temp_dir/Upgrade Download/TaskPulse.app"
bad_bundle="$temp_dir/Failure Download/TaskPulse.app"
installed_bundle="$ok_home/Applications/TaskPulse.app"
old_version=20261124
new_version=20261125
paused_pid=

bundle_pids() {
  local executable="$1/Contents/MacOS/TaskPulse"
  local pid command
  while read -r pid command; do
    case "$command" in
      "$executable"|"$executable "*) printf '%s\n' "$pid" ;;
    esac
  done < <(/bin/ps -axww -o pid= -o command=)
}

is_bundle_pid() {
  local bundle="$1" pid="$2"
  bundle_pids "$bundle" | grep -Fx -- "$pid" >/dev/null
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
      "$temp_dir"/{success,upgrade,failure}.out; do
      if [[ -f "$file" ]]; then
        printf '\n--- %s ---\n' "$file" >&2
        tail -n 60 "$file" >&2
      fi
    done
  fi
  if [[ -n "$paused_pid" ]] && is_bundle_pid "$installed_bundle" "$paused_pid"; then
    # Only resume the exact fixture we suspended, so a failed assertion cannot leave it stopped.
    kill -CONT "$paused_pid" 2>/dev/null || true
  fi
  stop_bundle "$ok_bundle"
  stop_bundle "$upgrade_bundle"
  stop_bundle "$bad_bundle"
  stop_bundle "$installed_bundle"
  rm -rf "$temp_dir"
  exit "$result"
}
trap cleanup EXIT

prepare_bundle() {
  local bundle="$1" binary="$2" version="$3"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  cp "$repo_dir/packaging/Info.plist" "$bundle/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$bundle/Contents/Info.plist"
  cp "$binary" "$bundle/Contents/MacOS/TaskPulse"
  chmod +x "$bundle/Contents/MacOS/TaskPulse"
  # Omit poller resources so the App stops before installing any runtime dependency.
  codesign --force --sign - "$bundle"
  codesign --verify --strict "$bundle"
}

expect_log() {
  local app_log="$1" marker="$2" first_line="${3:-1}" attempt
  for ((attempt = 0; attempt < 150; ++attempt)); do
    if [[ -f "$app_log" ]] && tail -n "+$first_line" "$app_log" | grep -F -- "$marker" >/dev/null; then
      return
    fi
    sleep 0.2
  done
  printf 'Timed out waiting for "%s" in %s\n' "$marker" "$app_log" >&2
  return 1
}

expect_exit() {
  local bundle="$1" pid="$2" attempt
  for ((attempt = 0; attempt < 75; ++attempt)); do
    if ! is_bundle_pid "$bundle" "$pid"; then
      return
    fi
    sleep 0.2
  done
  printf 'Timed out waiting for %s (PID %s) to exit.\n' "$bundle" "$pid" >&2
  return 1
}

mkdir "$ok_home" "$bad_home"
prepare_bundle "$ok_bundle" "$1" "$old_version"
TP_HOME="$ok_home" "$ok_bundle/Contents/MacOS/TaskPulse" >"$temp_dir/success.out" 2>&1 &
installer_pid=$!
ok_log="$ok_home/Library/Logs/taskpulse-app.log"
expect_log "$ok_log" "自我安装：已打开目标 App"
expect_log "$ok_log" "TaskPulse 界面已启动"
test -x "$installed_bundle/Contents/MacOS/TaskPulse"
codesign --verify --strict "$installed_bundle"
old_pid="$(bundle_pids "$installed_bundle")"
if [[ ! "$old_pid" =~ ^[0-9]+$ ]]; then
  echo "Expected exactly one installed TaskPulse process after initial startup." >&2
  exit 1
fi
expect_exit "$ok_bundle" "$installer_pid"
echo "Self-install and installed App startup passed."

prepare_bundle "$upgrade_bundle" "$1" "$new_version"
upgrade_log_line=$(( $(wc -l <"$ok_log") + 1 ))
# Suspend the old fixture so a normal AppKit quit request cannot be handled.
is_bundle_pid "$installed_bundle" "$old_pid"
kill -STOP "$old_pid"
paused_pid="$old_pid"
TP_HOME="$ok_home" "$upgrade_bundle/Contents/MacOS/TaskPulse" >"$temp_dir/upgrade.out" 2>&1 &
upgrade_pid=$!
expect_log "$ok_log" "自我安装：强制退出旧版 TaskPulse" "$upgrade_log_line"
expect_log "$ok_log" "自我安装：已打开目标 App" "$upgrade_log_line"
expect_log "$ok_log" "TaskPulse 界面已启动" "$upgrade_log_line"
expect_exit "$installed_bundle" "$old_pid"
paused_pid=
expect_exit "$upgrade_bundle" "$upgrade_pid"
new_pid="$(bundle_pids "$installed_bundle")"
if [[ ! "$new_pid" =~ ^[0-9]+$ || "$new_pid" == "$old_pid" ]]; then
  echo "Expected exactly one new installed TaskPulse process after upgrading." >&2
  exit 1
fi
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$installed_bundle/Contents/Info.plist")" = "$new_version"
codesign --verify --strict "$installed_bundle"
stop_bundle "$installed_bundle"
echo "Upgrade over an unresponsive installed App passed."

prepare_bundle "$bad_bundle" "$1" "$new_version"
# A regular file in place of the directory deterministically prevents installation.
touch "$bad_home/Applications"
TP_HOME="$bad_home" "$bad_bundle/Contents/MacOS/TaskPulse" >"$temp_dir/failure.out" 2>&1 &
bad_pid=$!
expect_log "$bad_home/Library/Logs/taskpulse-app.log" "自我安装失败"
if ! is_bundle_pid "$bad_bundle" "$bad_pid"; then
  echo "Installer exited instead of presenting its failure." >&2
  exit 1
fi
echo "Self-install failure keeps the installer running."
