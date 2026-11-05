# Windows installation and client setup (native LLMAPI)

## 1. Inventory

```powershell
Get-Command git, node, codex, copilot, m365-proxy, copilotm -All -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 4141 -State Listen -ErrorAction SilentlyContinue
Get-ScheduledTask -TaskName 'M365 Native Proxy 4141' -ErrorAction SilentlyContinue
copilot help providers
```

The personal skill directory may be a junction; preserve it. Inspect any existing
checkout with `git status --short` before touching it; never reset or clean a
dirty worktree. If a healthy listener exists, reuse it.

## 2. Isolated Node and pnpm

Paths used by every template:

```powershell
$install = Join-Path $env:LOCALAPPDATA 'm365-copilot-proxy'
$nodeVersion = '24.22.2'
$nodeDir = Join-Path $install "node-v$nodeVersion-win-x64"
$tools = Join-Path $install 'tools'
$repo = Join-Path $env:USERPROFILE 'repos\m365-copilot-proxy'
$bin = Join-Path $env:USERPROFILE '.local\bin'
$skill = Join-Path $env:USERPROFILE '.copilot\skills\m365-copilot-proxy'
```

For a new x64 install, download the official ZIP and verify its checksum:

```powershell
New-Item -ItemType Directory -Force -Path $install, $bin | Out-Null
$zipName = "node-v$nodeVersion-win-x64.zip"
$zip = Join-Path $install $zipName
Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$zipName" -OutFile $zip
$sums = Invoke-RestMethod "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt"
$line = ($sums -split "`n") | Where-Object { $_.TrimEnd().EndsWith("  $zipName") }
if (@($line).Count -ne 1) { throw 'Cannot identify the official Node checksum.' }
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne ($line -split '\s+')[0]) { throw 'Checksum mismatch.' }
Expand-Archive -LiteralPath $zip -DestinationPath $install
& "$nodeDir\npm.cmd" install --prefix $tools pnpm@10.32.1
```

Node 24 is required (`node:sqlite`). A different Node version or location must be
updated in every template (`m365-proxy.cmd`, `copilotm.cmd`, `copilotm.ps1`).
On managed networks use the approved registry; never disable TLS verification.

## 3. Source, build and tests

```powershell
if (-not (Test-Path $repo)) { git clone https://github.com/rinceyuan/m365-copilot-proxy $repo }
git -C $repo status --short          # must be clean before switching
git -C $repo switch main
git -C $repo pull --ff-only
$env:PATH = "$nodeDir;$tools;$env:PATH"
Set-Location $repo
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run packages/proxy-lib/src/llmapi.test.ts `
    packages/proxy-lib/src/llmapi-compat.test.ts `
    packages/proxy-lib/src/llmapi-app-managed.test.ts `
    packages/proxy-lib/src/responses.test.ts
```

`koffi` (DPAPI binding) is a pinned dependency. The running proxy locks the Nitro
output and Koffi binary: stop the owned proxy PID before rebuilding, then restart
it through the scheduled task. Known unrelated full-suite failures on Windows:
`core/src/log.test.ts` and `scripts/bench/turn-budget.test.mjs` POSIX paths.

## 4. Authorization and local client key

App-managed mode (`M365_LLMAPI_AUTH=app-managed`) reads
`%LOCALAPPDATA%\Microsoft\Copilot\User Data\CopilotCodingHome\<profile>\data.db`
read-only, validates the `undocked-anthropic` provider, the exact Loki endpoint and
the four stored metadata headers, then decrypts the protected authorization with
current-user DPAPI in memory for each request. Prerequisite: the user opened a
Claude Code session in the M365 Copilot app. Multiple profiles require
`M365_LLMAPI_PROFILE`. Expired authorization returns 503
`m365_authorization_expired`; the user reopens the app's Code session.
The optional authorization guard in section 6.1 attempts a normal app launch on
this exact error. It does not refresh credentials itself.

Generate the local client key once (never commit or print it):

```powershell
$keyFile = Join-Path $install '.state\llmapi\client-key'
if (-not (Test-Path $keyFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keyFile) | Out-Null
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [IO.File]::WriteAllText($keyFile, [Convert]::ToBase64String($bytes))
}
```

The file inherits the user-profile ACL (user + SYSTEM). `packages\proxy\bin\
llmapi-key.mjs` prints it for `COPILOT_PROVIDER_API_KEY_COMMAND`. Selected routes
also reject non-loopback hosts and browser `Origin` headers.

Explicit mode (`M365_LLMAPI_AUTH=explicit`) instead needs a caller bearer or
`M365_LLMAPI_TOKEN` authorized for LLMAPI; existing proxy/Azure CLI OAuth clients
returned `AADSTS65002`. The `/llmapi/v1` relay is always caller-bearer-only.

## 5. Proxy launcher

Back up any differing destination, then install:

```powershell
Copy-Item "$skill\templates\m365-proxy.cmd" "$bin\m365-proxy.cmd"
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('PATH', "$bin;$userPath", 'User')
}
```

It sets `HOST`/`NITRO_HOST=127.0.0.1`, `M365_BACKEND=llmapi`,
`M365_LLMAPI_AUTH=app-managed`, the key file, clears `M365_LLMAPI_TOKEN` and the
legacy fallback, and enables metadata-only diagnostics (`M365_DEBUG=1`,
`M365_LOG_FILE=...\native-diagnostics.log`, `M365_TRACE` cleared). Diagnostics log
status, request IDs, stop reason, optional refusal category and token counts —
never prompts, outputs, thinking, tool payloads or credentials. Do not enable
`M365_TRACE`.

## 6. Startup at logon

```powershell
Copy-Item "$skill\templates\m365-proxy-autostart.vbs" "$bin\m365-proxy-autostart.vbs"
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
    -Argument "//B //NoLogo `"$bin\m365-proxy-autostart.vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user; $trigger.Delay = 'PT15S'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'M365 Native Proxy 4141' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Starts the local M365 native LLMAPI proxy on 127.0.0.1:4141 at user logon.'
```

The task must run as the interactive user (DPAPI is per user). The VBS exits 0 if
`/health` is already OK; otherwise it runs the launcher hidden, writes
`.state\llmapi\autostart.log` (overwritten per start) and waits, so the task shows
`Running` (last result 267009) while the proxy lives. To restart: verify the
listener PID's command line, `Stop-Process -Id <pid>`, then
`Start-ScheduledTask 'M365 Native Proxy 4141'`. Disable the task to stop autostart.

### 6.1. Authorization monitoring and assisted recovery

```powershell
& "$nodeDir\node.exe" --test "$skill\scripts\m365-proxy-auth-guard.test.mjs"
& "$skill\scripts\install-auth-guard.ps1"
Start-ScheduledTask -TaskName 'M365 Proxy Authorization Guard'
Get-ScheduledTaskInfo -TaskName 'M365 Proxy Authorization Guard'
Get-Content "$install\.state\llmapi\auth-guard.json"
```

This is assisted recovery, not an automatic token-renewal service. The separate
current-user task runs 45 seconds after logon and every five minutes.
It authenticates local model discovery with the local client key. Only HTTP 503
`m365_authorization_expired` triggers a normal launch of the existing M365 app via
`.local\bin\m365-code.lnk`. It polls for up to six additional checks, then continues
scheduled monitoring. A persisted one-hour launch cooldown prevents popup loops
across invocations/logons. Task instances cannot overlap.

The shortcut has no guessed Code URI or command-line flags. Normal app activation
can restore its last view; if it does not enter Code, the user must enter Code.
An app launch is not proof of renewed authorization: only successful authenticated
discovery records `healthy`. Network failures, throttling, bad local keys and other
auth errors never trigger app launches. It sends no chat messages and does not
restart the proxy, acquire/export Microsoft tokens, enter passwords or handle MFA.
Failed silent renewal still needs user interaction.

Logs are bounded metadata-only phase transitions in `auth-guard.log` (512 KiB plus
one previous file); `auth-guard.json` holds only the phase and last launch time.
`awaiting-sign-in` means app activation did not restore authorization in the polling
window. Disable `M365 Proxy Authorization Guard` to stop this feature without
changing proxy startup. Reinstall only while the guard task is not running.

Observed on 2026-11-05: existing proxy PID 4004 survived reboot, while authenticated
discovery initially returned expired authorization; discovery later recovered to
10 models with the native Code app open. The guard's expiry, recovery and cooldown
branches have isolated tests. Automatic expired-to-healthy recovery through this
guard has not yet been observed; the minimized app window prevented verifying a
direct Code launch, so no unverified direct-Code activation was installed.
Do not describe a healthy guard run or mocked recovery test as proof that the app
can silently renew an expired sign-in. That requires an observed real expiry and
successful authenticated discovery after ordinary app activation.

The registered task was also observed firing without a manual start at
2026-11-05 10:03:41 +08:00: result 0, state file updated at 10:03:42 with `healthy`,
next run 10:08:41, repetition `PT5M`, logon delay `PT45S`, and original proxy PID
4004 unchanged. This verifies unattended scheduling, not automatic token renewal.

## 7. copilotm (Copilot CLI)

```powershell
foreach ($f in 'copilotm.cmd', 'copilotm.ps1', 'copilotm.mjs') {
    Copy-Item "$skill\templates\$f" "$bin\$f"
}
```

`copilotm.mjs` checks `/health`, clears inherited `COPILOT_MODEL`, provider model
IDs, API keys, bearer tokens and headers in the child environment only, sets
`COPILOT_PROVIDER_API_KEY_COMMAND` to the key helper, and launches `copilot.exe`:

- `claude-*` → `COPILOT_PROVIDER_TYPE=anthropic`, base `http://127.0.0.1:4141`
  (native Messages; thinking, effort and signatures preserved).
- Any other model → `openai`, base `http://127.0.0.1:4141/v1`,
  `COPILOT_PROVIDER_WIRE_API=responses`.
- Adds `--model claude-opus-5.5` and `--reasoning-effort high` only when absent.
- Ignores Ctrl+C itself (copilot handles it) and forwards the exit code.

PowerShell resolves `copilotm.ps1` before `.cmd` (needs `RemoteSigned` or looser);
cmd uses `copilotm.cmd`. Usage:

```powershell
copilotm                                   # Opus 5.5 / high
copilotm --model gpt-61-sol                # GPT-6.1 Sol / high
copilotm --model claude-sonnet-5.5 --reasoning-effort medium
copilotm --resume <id> --model gpt-61-sol  # continue a session on GPT
copilotm --resume <id>                     # back to Opus 5.5
```

Do not change existing permissions or add `--allow-all*` flags.

## 8. Codex CLI and desktop

Merge into `~\.codex\config.toml` (back up first; keep other tables):

```toml
model = "claude-opus-5.5"
model_provider = "m365"
model_reasoning_effort = "medium"

[model_providers.m365]
name = "M365 Copilot"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
env_key = "M365_PROXY_API_KEY"
requires_openai_auth = false
supports_websockets = false
```

Set the user environment variable `M365_PROXY_API_KEY` to the client key value
(`[Environment]::SetEnvironmentVariable('M365_PROXY_API_KEY', $key, 'User')`).
This stores the local key in the user environment; it is a loopback-only key, not
a Microsoft credential. Restart terminals/VS Code/Codex desktop afterwards.

In app-managed mode Codex Claude requests are adapted once to native Messages
(reasoning effort → adaptive thinking + `output_config.effort`; signed thinking
carried in a base64 `reasoning.encrypted_content` tag, not encryption). GPT
Responses pass through unchanged. For the desktop picker, regenerate
`m365.models.json` (`codex-desktop.md`).

## Sources when versions change

- The repo's `README.md` and `docs\m365-copilot-api.md` (native backend section).
- `copilot help providers`, `copilot --help`, `codex --help`,
  `codex debug models --help` from the installed binaries.
- Live `GET /v1/models` (with the key) for IDs, endpoints and efforts.
