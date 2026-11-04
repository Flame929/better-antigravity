#!/bin/bash
# 安装 Antigravity HUD：复制到 ~/.antigravity-hud，并注册登录后自动运行的 LaunchAgent
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.antigravity-hud"
LABEL="com.antigravity-hud.injector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "没有找到 node，请先安装 Node.js 22 或更高版本" >&2
  exit 1
fi

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$SRC/hud.js" "$SRC/inject.mjs" "$DEST/"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DEST/inject.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/inject.log</string>
  <key>StandardErrorPath</key><string>$DEST/inject.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout 是异步的，等旧进程完全退出再 bootstrap，否则会报 Input/output error
for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装到 $DEST，注入器已在后台运行（日志：$DEST/inject.log）"
echo "以后修改 $DEST/hud.js 后，刷新一次 Antigravity 窗口（Cmd+R）即可生效"
