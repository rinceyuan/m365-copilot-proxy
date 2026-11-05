Option Explicit

Dim shell, node, script, command
Set shell = CreateObject("WScript.Shell")
node = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\m365-copilot-proxy\node-v24.22.2-win-x64\node.exe")
script = shell.ExpandEnvironmentStrings("%USERPROFILE%\.local\bin\m365-proxy-auth-guard.mjs")
command = """" & node & """ """ & script & """"
WScript.Quit shell.Run(command, 0, True)
