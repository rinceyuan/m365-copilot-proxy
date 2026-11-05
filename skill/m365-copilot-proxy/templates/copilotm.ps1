# PowerShell entry for copilotm: calls Node directly so quoted arguments are not
# re-parsed by cmd.exe. Routing and defaults live in copilotm.mjs.
& "$env:LOCALAPPDATA\m365-copilot-proxy\node-v24.22.2-win-x64\node.exe" "$PSScriptRoot\copilotm.mjs" @args
exit $LASTEXITCODE
