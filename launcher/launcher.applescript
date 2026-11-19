-- 带 HUD 启动 Antigravity：Antigravity 2.33 起，远程调试端口只在启动参数里带 --remote-debugging-port 时才打开，
-- HUD 靠这个端口注入。用这个启动器代替 Dock 里的 Antigravity 图标打开应用。
set portFile to (POSIX path of (path to home folder)) & "Library/Application Support/Antigravity/DevToolsActivePort"
set isRunning to application id "com.google.antigravity" is running
set hasPort to (do shell script "test -f " & quoted form of portFile & " && echo yes || echo no") is "yes"

if isRunning and hasPort then
	tell application id "com.google.antigravity" to activate
	return
end if

if isRunning then
	set answer to button returned of (display dialog "Antigravity 正在运行，但没有开启 HUD 需要的调试端口。要退出后重新打开吗？" & return & return & "正在进行的对话和任务可能会被打断。" buttons {"取消", "重新打开"} default button "重新打开" with title "Better Antigravity")
	if answer is not "重新打开" then return
	tell application id "com.google.antigravity" to quit
	repeat 60 times
		if not (application id "com.google.antigravity" is running) then exit repeat
		delay 0.5
	end repeat
end if

do shell script "open -b com.google.antigravity --args --remote-debugging-port=0"
