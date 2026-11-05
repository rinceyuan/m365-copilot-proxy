' Starts the local M365 native proxy on 127.0.0.1:4141 without a console window.
' Exits immediately when a healthy proxy is already listening.
Option Explicit

Dim shell, http, healthy, launcher, logFile, command
Set shell = CreateObject("WScript.Shell")

healthy = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 2000, 2000, 2000, 3000
http.open "GET", "http://127.0.0.1:4141/health", False
http.send
If Err.Number = 0 Then
  If http.status = 200 Then healthy = True
End If
Err.Clear
On Error GoTo 0
If healthy Then WScript.Quit 0

launcher = shell.ExpandEnvironmentStrings("%USERPROFILE%\.local\bin\m365-proxy.cmd")
logFile = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\m365-copilot-proxy\.state\llmapi\autostart.log")
command = "cmd.exe /d /c """"" & launcher & """ 4141 > """ & logFile & """ 2>&1"""
WScript.Quit shell.Run(command, 0, True)
