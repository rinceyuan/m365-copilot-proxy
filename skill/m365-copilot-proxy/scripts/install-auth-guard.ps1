$ErrorActionPreference = 'Stop'
$skill = Split-Path $PSScriptRoot -Parent
$bin = Join-Path $env:USERPROFILE '.local\bin'
$node = Join-Path $env:LOCALAPPDATA 'm365-copilot-proxy\node-v24.22.2-win-x64\node.exe'
$app = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Copilot\Application\copilotapp.exe'
foreach ($file in @($node, $app, (Join-Path $bin 'm365-proxy.cmd'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required installed file is unavailable: $file"
    }
}

$taskName = 'M365 Proxy Authorization Guard'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw 'The authorization guard is currently running. Wait for it to finish before reinstalling.'
}
foreach ($name in @('m365-proxy-auth-guard.mjs', 'm365-proxy-auth-guard.vbs')) {
    Copy-Item -LiteralPath (Join-Path $skill "templates\$name") -Destination (Join-Path $bin $name)
}
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $bin 'm365-code.lnk'))
$shortcut.TargetPath = $app
$shortcut.Arguments = ''
$shortcut.Description = 'Open M365 Copilot to let the app renew its Code authorization'
$shortcut.WindowStyle = 1
$shortcut.Save()

$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
    -Argument "//B //NoLogo `"$(Join-Path $bin 'm365-proxy-auth-guard.vbs')`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT45S'
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $periodic) `
    -Principal $principal -Settings $settings -Force `
    -Description 'Checks M365 authorization every five minutes and at logon. Opens the installed M365 app on exact authorization expiry, at most once per hour; never automates credentials or MFA.' | Out-Null
