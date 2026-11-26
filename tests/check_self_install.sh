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
ok_bundle="$temp_dir/Success Download/Install TaskPulse.app"
upgrade_bundle="$temp_dir/Upgrade Download/Install TaskPulse.app"
offline_bundle="$temp_dir/Offline Upgrade Download/Install TaskPulse.app"
bad_bundle="$temp_dir/Failure Download/Install TaskPulse.app"
payload_bundle="$temp_dir/Payload/TaskPulse.app"
other_bundle="$temp_dir/Another Copy/TaskPulse.app"
other_home="$temp_dir/Another Home"
installed_bundle="$ok_home/Applications/TaskPulse.app"
old_version=20261124
new_version=20261125
paused_pid=

bundle_pids() {
  local executable="$1/Contents/MacOS/${2:-TaskPulse}"
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
  done < <(bundle_pids "$bundle" "${2:-TaskPulse}")
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    local file
    for file in "$ok_home/Library/Logs/taskpulse-app.log" "$bad_home/Library/Logs/taskpulse-app.log" \
      "$other_home/Library/Logs/taskpulse-app.log"; do
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
  stop_bundle "$ok_bundle" TaskPulseInstaller
  stop_bundle "$upgrade_bundle" TaskPulseInstaller
  stop_bundle "$offline_bundle" TaskPulseInstaller
  stop_bundle "$bad_bundle" TaskPulseInstaller
  stop_bundle "$other_bundle"
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

prepare_installer() {
  prepare_bundle "$payload_bundle" "$2" "$3"
  mkdir -p "$(dirname "$1")"
  bash "$repo_dir/packaging/wrap_installer.sh" "$payload_bundle" "$1"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist")" = com.hyj.taskpulse.installer
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Helpers/TaskPulse.app/Contents/Info.plist")" = com.hyj.taskpulse
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
  local bundle="$1" pid="$2" executable="${3:-TaskPulse}" attempt
  for ((attempt = 0; attempt < 75; ++attempt)); do
    if ! bundle_pids "$bundle" "$executable" | grep -Fx -- "$pid" >/dev/null; then
      return
    fi
    sleep 0.2
  done
  printf 'Timed out waiting for %s (PID %s) to exit.\n' "$bundle" "$pid" >&2
  return 1
}

expect_installer_exit() {
  local bundle="$1" log="$2" first_line="${3:-1}" pid
  pid="$(tail -n "+$first_line" "$log" | sed -n 's/^.*启动 pid=\([0-9][0-9]*\) role=installer .*$/\1/p')"
  test -n "$pid"
  expect_exit "$bundle" "$pid" TaskPulseInstaller
}

mkdir "$ok_home" "$bad_home" "$other_home"
prepare_installer "$ok_bundle" "$1" "$old_version"
prepare_bundle "$other_bundle" "$1" "$old_version"
# A same-identifier runtime from another directory must survive a first install.
/usr/bin/open --env "TP_HOME=$other_home" "$other_bundle"
expect_log "$other_home/Library/Logs/taskpulse-app.log" "TaskPulse 界面已启动"
other_pid="$(bundle_pids "$other_bundle")"
test -n "$other_pid"
test ! -e "$installed_bundle"
# Use Launch Services, as Finder does, including when another app is running.
/usr/bin/open --env "TP_HOME=$ok_home" "$ok_bundle"
ok_log="$ok_home/Library/Logs/taskpulse-app.log"
expect_log "$ok_log" "自我安装：已打开目标 App"
expect_log "$ok_log" "TaskPulse 界面已启动"
expect_installer_exit "$ok_bundle" "$ok_log"
test -x "$installed_bundle/Contents/MacOS/TaskPulse"
codesign --verify --strict "$installed_bundle"
old_pid="$(bundle_pids "$installed_bundle")"
if [[ ! "$old_pid" =~ ^[0-9]+$ ]]; then
  echo "Expected exactly one installed TaskPulse process after initial startup." >&2
  exit 1
fi
is_bundle_pid "$other_bundle" "$other_pid"
stop_bundle "$other_bundle"
expect_exit "$other_bundle" "$other_pid"
echo "Self-install and installed App startup passed."

prepare_installer "$upgrade_bundle" "$1" "$new_version"
upgrade_log_line=$(( $(wc -l <"$ok_log") + 1 ))
# Suspend the old fixture so a normal AppKit quit request cannot be handled.
is_bundle_pid "$installed_bundle" "$old_pid"
kill -STOP "$old_pid"
paused_pid="$old_pid"
/usr/bin/open --env "TP_HOME=$ok_home" "$upgrade_bundle"
expect_log "$ok_log" "自我安装：强制退出旧版 TaskPulse" "$upgrade_log_line"
expect_log "$ok_log" "自我安装：已打开目标 App" "$upgrade_log_line"
expect_log "$ok_log" "TaskPulse 界面已启动" "$upgrade_log_line"
expect_installer_exit "$upgrade_bundle" "$ok_log" "$upgrade_log_line"
expect_exit "$installed_bundle" "$old_pid"
paused_pid=
new_pid="$(bundle_pids "$installed_bundle")"
if [[ ! "$new_pid" =~ ^[0-9]+$ || "$new_pid" == "$old_pid" ]]; then
  echo "Expected exactly one new installed TaskPulse process after upgrading." >&2
  exit 1
fi
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$installed_bundle/Contents/Info.plist")" = "$new_version"
codesign --verify --strict "$installed_bundle"
stop_bundle "$installed_bundle"
expect_exit "$installed_bundle" "$new_pid"
echo "Upgrade over an unresponsive installed App passed."

offline_version=$((new_version + 1))
prepare_installer "$offline_bundle" "$1" "$offline_version"
offline_log_line=$(( $(wc -l <"$ok_log") + 1 ))
test -z "$(bundle_pids "$installed_bundle")"
/usr/bin/open --env "TP_HOME=$ok_home" "$offline_bundle"
expect_log "$ok_log" "自我安装：已打开目标 App" "$offline_log_line"
expect_log "$ok_log" "TaskPulse 界面已启动" "$offline_log_line"
expect_installer_exit "$offline_bundle" "$ok_log" "$offline_log_line"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$installed_bundle/Contents/Info.plist")" = "$offline_version"
if tail -n "+$offline_log_line" "$ok_log" | grep -F '请求退出旧版 TaskPulse'; then
  echo "Installer tried to stop an old process during an offline upgrade." >&2
  exit 1
fi
echo "Upgrade with no prior TaskPulse process passed."

prepare_installer "$bad_bundle" "$1" "$new_version"
# A regular file in place of the directory deterministically prevents installation.
touch "$bad_home/Applications"
/usr/bin/open --env "TP_HOME=$bad_home" "$bad_bundle"
expect_log "$bad_home/Library/Logs/taskpulse-app.log" "自我安装失败"
if [[ -z "$(bundle_pids "$bad_bundle" TaskPulseInstaller)" ]]; then
  echo "Installer exited instead of presenting its failure." >&2
  exit 1
fi
echo "Self-install failure keeps the installer running."

# Exercise the installed runtime's actual launch path with an isolated local fixture.
bash "$repo_dir/tests/check_bootstrap_startup.sh" "$1"
