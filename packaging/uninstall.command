#!/bin/bash
# TaskPulse 卸载脚本：双击运行
set -uo pipefail

echo "== 卸载 TaskPulse =="
launchctl bootout "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.taskpulse.poller.plist" \
      "$HOME/Library/LaunchAgents/com.taskpulse.ui.plist"
rm -rf "$HOME/Applications/TaskPulse.app" \
       "$HOME/Applications/TaskPulse"
# 状态文件按需保留（里面有你的任务历史）
echo "-- 已卸载。"
echo "   如需清空历史状态：rm -rf ~/.taskpulse"
echo "   如需删除偏好：defaults delete com.taskpulse.TaskPulse 2>/dev/null || true"
