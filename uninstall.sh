#!/bin/bash
# 卸载 Antigravity HUD：停止注入器、移除 LaunchAgent，并从当前打开的窗口里移除 HUD
set -uo pipefail

DEST="$HOME/.antigravity-hud"
LABEL="com.antigravity-hud.injector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
[ -f "$DEST/inject.mjs" ] && node "$DEST/inject.mjs" --remove 2>/dev/null
rm -f "$PLIST"
rm -rf "$DEST"
echo "已卸载 Antigravity HUD"
