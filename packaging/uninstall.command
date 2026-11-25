#!/bin/bash
# TaskPulse 卸载脚本：双击运行
set -uo pipefail

echo "== 卸载 TaskPulse =="
launchctl bootout "gui/$(id -u)/com.taskpulse.poller" 2>/dev/null
launchctl bootout "gui/$(id -u)/com.taskpulse.ui" 2>/dev/null
# 连同 .plist.bak 备份、早期版本的 disabled 目录一起清掉，避免重装后出现两份登记
rm -f "$HOME/Library/LaunchAgents/com.taskpulse."*.plist*
rm -rf "$HOME/Library/LaunchAgents/disabled-taskpulse"
rm -rf "$HOME/Applications/TaskPulse.app" \
       "$HOME/Applications/TaskPulse"
rm -f "$HOME/Desktop/TaskPulse"
defaults delete com.hyj.taskpulse 2>/dev/null
# 状态文件按需保留（里面有你的任务历史）
echo "-- 已卸载（含后台项目登记与界面偏好）。"
echo "   任务历史仍保留在 ~/.taskpulse"
echo "   彻底清空：rm -rf ~/.taskpulse"
