#!/bin/bash
# TaskPulse 卸载脚本：双击运行
set -uo pipefail

echo "== 卸载 TaskPulse =="
# 现在取数服务由 App 自己拉起，不再走 launchd：直接结束进程。
# 老版本装过的还会留着 plist，下面一并清掉。
for svc in com.taskpulse.poller com.taskpulse.ui; do
  launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
done
pkill -f "TaskPulse.app/Contents/MacOS/TaskPulse" 2>/dev/null || true
pkill -f "Applications/TaskPulse/poller.py" 2>/dev/null || true
sleep 1
# 连同 .plist.bak 备份、早期版本的 disabled 目录一起清掉，避免重装后出现两份登记
rm -f "$HOME/Library/LaunchAgents/com.taskpulse."*.plist*
rm -rf "$HOME/Library/LaunchAgents/disabled-taskpulse"
rm -rf "$HOME/Applications/TaskPulse.app" \
       "$HOME/Applications/TaskPulse"
rm -f "$HOME/Desktop/TaskPulse"
rm -f "$HOME/.taskpulse/runtime.json"
rm -f "$HOME/.taskpulse/installer.lock" "$HOME/.taskpulse/ui.lock"
defaults delete com.hyj.taskpulse 2>/dev/null
# 状态文件按需保留（里面有你的任务历史）
echo "-- 已卸载（含后台项目登记与界面偏好）。"
echo "   任务历史仍保留在 ~/.taskpulse"
echo "   彻底清空：rm -rf ~/.taskpulse"
