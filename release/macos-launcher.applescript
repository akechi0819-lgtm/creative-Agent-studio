on run
	set bundlePath to POSIX path of (path to me)
	set packageRoot to do shell script "/usr/bin/dirname " & quoted form of bundlePath
	set selected to choose from list {"启动或打开工作台", "停止工作台", "查看运行状态"} with title "Creative Agent Studio" with prompt "本地工作台控制" default items {"启动或打开工作台"} OK button name "继续" cancel button name "退出"
	if selected is false then return
	set actionName to "start"
	if item 1 of selected is "停止工作台" then set actionName to "stop"
	if item 1 of selected is "查看运行状态" then set actionName to "status"
	set nodeDirectoryName to "__NODE_DIRECTORY__"
	set nodePath to packageRoot & "/.studio-runtime/node/" & nodeDirectoryName & "/bin/node"
	set launcherPath to packageRoot & "/release/launcher.mjs"
	try
		display notification "正在启动或检查本机工作台…" with title "Creative Agent Studio"
		set resultText to do shell script quoted form of nodePath & " " & quoted form of launcherPath & " " & actionName
		display dialog resultText buttons {"关闭"} default button 1 with title "Creative Agent Studio"
	on error errorText number errorNumber
		display alert "操作未完成" message errorText as warning buttons {"关闭"} default button 1
	end try
end run
