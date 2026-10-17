Option Explicit
Dim shell, fso, rootPath, powershellPath, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootPath = fso.GetParentFolderName(WScript.ScriptFullName)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
scriptPath = rootPath & "\release\windows-start.ps1"
command = """" & powershellPath & """ -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run command, 0, True
