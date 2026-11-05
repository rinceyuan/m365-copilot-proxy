---
name: m365-copilot-proxy
description: 'Install and maintain the rinceyuan/m365-copilot-proxy native LLMAPI (Loki) backend on Windows. App-managed authorization from the M365 Copilot app Code profile, local client key, loopback 4141 proxy with a logon scheduled task. Configure copilotm (Claude via native Anthropic Messages, GPT via OpenAI Responses, default claude-opus-5.5 high), Codex CLI/Desktop (Responses) and VS Code Copilot Chat BYOK Custom Endpoint (per-model Messages/Responses). Use for m365-proxy 4141, copilotm, Codex M365 provider, Codex desktop model catalog, VS Code chatLanguageModels.json, Manage Language Models, Loki /models, app-managed authorization expired, content_filter refusals, GPT capacity errors, and cross-model session resumption.'
argument-hint: 'Install or repair the native proxy, configure copilotm or Codex, refresh model discovery, or troubleshoot'
---

# M365 native proxy, copilotm and Codex

## Read first

Windows-only setup procedure for the user's fork. Read
`references\windows-setup.md` for installation, launchers, startup and clients.
Read `references\codex-desktop.md` only for the Codex desktop model catalog.
Read `references\vscode-copilot.md` for VS Code Copilot Chat (BYOK) integration.

| Entry point | Route | Scope |
|---|---|---|
| `m365-proxy 4141` | Loki LLMAPI, app-managed auth | Loopback only, local client key |
| Task "M365 Native Proxy 4141" | Same, started at logon | Current user, hidden |
| Task "M365 Proxy Authorization Guard" | Authenticated discovery every 5 minutes | Assisted recovery: opens M365 on expiry, at most once/hour |
| `copilotm` | `claude-*` → `/v1/messages`; others → `/v1/responses` | Process-local BYOK env |
| `codex` / Codex desktop | `/v1/responses` (Claude adapted to Messages) | Shared `~\.codex\config.toml` |
| VS Code Copilot Chat | Custom Endpoint: Claude `/v1/messages`, GPT `/v1/responses` | `chatLanguageModels.json`, key in VS Code secret storage |
| `copilot` | Original GitHub Copilot routing | Leave untouched |

Upstream: `https://loki.delve.office.com/api/v1/llmapi`, provider
`undocked-anthropic`, headers `X-ClientScenario: Code`, `X-ClientType: Copilot`,
`X-ClientFeature: LlmApiProxy`, `X-Llm-Api-Version: 2026-09-22`.
Source: `https://github.com/rinceyuan/m365-copilot-proxy` `main` (verified at
`93372d4`). No patch is needed; the legacy Sydney patch was retired.

### Required invariants

- Keep `copilot` and its configuration intact. `copilotm` shares `COPILOT_HOME`,
  sessions, skills, plugins, instructions, MCP and GitHub login. Never fork a home.
- Never persist `COPILOT_PROVIDER_*` globally; launchers set them per process.
- App-managed auth only *reads* the M365 Copilot app's protected Code provider
  (read-only SQLite + current-user DPAPI) per request. Never export, log, copy or
  independently refresh Microsoft credentials. The app renews its own sign-in.
- Clients use a separate random local key (`.state\llmapi\client-key`), never the
  Microsoft authorization. Keep the proxy on `127.0.0.1`.
- Native Messages is a byte-preserving relay: thinking, `output_config.effort`,
  signatures, tools and SSE pass through. No retries, no model fallback, no
  moderation/entitlement override headers, no prompt-emulated tools.
- Model IDs and efforts come from Loki `/models` (via local `/v1/models` with the
  key). Do not reuse Sydney IDs (`claude-opus-4.8`, `gpt-6.1-sol`, `*-think-deeper`).
- `copilotm` defaults: `--model claude-opus-5.5 --reasoning-effort high` (not
  max), added only when the user does not pass them.
- Never weaken permissions, trust, sandboxing or TLS, and never add approval
  flags to make a test pass.

## Workflow

1. **Inspect first**: commands (`Get-Command copilotm, m365-proxy, codex,
   copilot`), listener on 4141, scheduled task, repo worktree, key file, Codex
   config. Reuse a healthy listener; never start a duplicate.
2. **Install/update the fork** with the isolated Node/pnpm, build, and run the
   affected tests (`windows-setup.md` §2–3).
3. **Authorization**: the user must have opened a Claude Code session in the M365
   Copilot app once. Generate the local client key (§4).
4. **Launchers and startup** from `templates\` (§5–6). After changing the proxy
   launcher, restart only the owned proxy (stop exact PID, then the task).
5. **Clients**: `copilotm` templates (§7); Codex provider + `M365_PROXY_API_KEY`
   (§8); desktop catalog from `codex-desktop.md`; VS Code provider via
   `scripts\merge-vscode-models.mjs`, then the user pastes the key in
   **Chat: Manage Language Models** (`vscode-copilot.md`).
6. **Validate sequentially** (Acceptance checks). For tool/autopilot claims require
   real `view` + PowerShell + executed `task_complete` events, not prose.
7. **Finish cleanly**: leave the requested proxy running, stop owned temporary
   processes, remove temp files, confirm `copilot` is unchanged.

## Bundled resources

- `templates\m365-proxy.cmd`: native backend env, metadata-only diagnostics,
  preloads `m365-proxy-auto-egress.cjs`, same-line exit handling.
- `templates\m365-proxy-auto-egress.cjs`: runtime Undici dispatcher hook that
  probes `127.0.0.1:7897` and automatically switches between `PROXY` (Claude + GPT)
  and `DIRECT` (GPT fallback when Clash Verge is closed) without restarting.
- `templates\m365-proxy-autostart.vbs`: hidden start, skips if `/health` is OK.
- `templates\m365-proxy-auth-guard.mjs` / `.vbs`: bounded expiry detection,
  assisted app activation and persisted cooldown; no credential renewal.
- `scripts\install-auth-guard.ps1` (+ guard test): installs the independent
  current-user task and normal app shortcut; see Windows setup section 6.1.
- `templates\copilotm.cmd` / `copilotm.ps1` / `copilotm.mjs`: per-model protocol
  routing; `.ps1` is preferred by PowerShell and preserves quoted arguments.
- `scripts\build-codex-catalog.mjs` (+ test): Codex desktop catalog from the
  installed Codex bundled template and the native `/models` (names, efforts).
- `scripts\merge-vscode-models.mjs` (+ test): merge the "M365" Custom
  Endpoint provider into VS Code; keeps other providers and the stored key reference.
- `references\compatibility-baseline.json`: verified versions and results.

## Acceptance checks

```powershell
Invoke-RestMethod http://127.0.0.1:4141/health            # {"status":"ok"}
$k = (Get-Content -Raw "$env:LOCALAPPDATA\m365-copilot-proxy\.state\llmapi\client-key").Trim()
(Invoke-RestMethod http://127.0.0.1:4141/v1/models -Headers @{'x-api-key'=$k}).data.id
copilotm -p 'Reply only M365_OK. Do not use tools.' --silent
copilotm --model gpt-61-sol -p 'Reply only GPT_OK. Do not use tools.' --silent
codex exec --skip-git-repo-check 'Reply only CODEX_OK. Do not run commands.'
Get-ScheduledTask -TaskName 'M365 Native Proxy 4141'
```

Unauthenticated `/v1/models` must return 401. For cross-model resumption, read a
harmless nonce fixture with `view` in a named session, `--resume <id> --model
gpt-61-sol` and ask for the nonce without rereading, then `--resume <id>` again
(defaults back to Opus 5.5). Check only that owned session's
`session.model_change` events.

## Boundaries and known limitations

- Copilot CLI BYOK uses one provider per process: the protocol is fixed at launch.
  In-session `/model` cannot cross Claude↔GPT; resume with `--model` instead.
  VS Code Custom Endpoint has per-model API types, so its picker can switch freely.
- VS Code BYOK has no context-size picker; Opus 5.5 is listed in one group as
  `claude-opus-5.5` (400K, default), `@200k` and `@1m`; the proxy strips the
  `@<size>` suffix before forwarding. An empty Opus reply after a successful
  `task_complete` makes VS Code autopilot retry 3× and show "no response was
  returned" — cosmetic, client-side (see `vscode-copilot.md`).
- VS Code BYOK needs the org policy "Bring Your Own Language Model Key in VS Code"
  (Business/Enterprise) and, for Copilot harness sessions,
  `chat.agentHost.byokModels.enabled`. Completions/embeddings stay on GitHub.
- Upstream: Claude IDs support only `/v1/messages`; GPT IDs only `/responses`.
  The proxy adapts Claude Chat/Responses to Messages (app-managed mode only); it
  does not adapt GPT to Messages, so `copilotm` must route GPT via Responses.
- Advertised 1M/1.05M context and efforts are catalog metadata. Verified: Opus 5.5
  all five efforts, ~222K-token CLI autopilot with real tools; GPT IDs text +
  one `view` tool loop. Not a broad long-task benchmark.
- `gpt-6-sol` intermittently returns "No active route ... serving capacity"
  (upstream); retry later rather than switching models silently.
- A resumed Opus session once ended in repeated `content_filter` (native
  `refusal`) and autopilot stopped; the trigger/category was not recoverable.
  Fresh 219K–222K controls passed. Do not replay that history or touch moderation
  headers; read `native-diagnostics.log` (`native_stop`: stop_reason,
  refusal_category if supplied, request IDs).
- 503 `m365_authorization_expired`: open the M365 Copilot app's Code session so the
  app renews sign-in; do not acquire tokens another way. Other OAuth clients
  returned `AADSTS65002` for this resource. The optional authorization guard
  attempts normal app activation automatically, not a verified direct-Code URI.
  Code navigation, re-login or MFA may still require the user. An app launch alone
  never counts as recovered authorization.
- Batch files: never edit a `.cmd` while a CMD is executing it unless invocation
  and exit are on one parsed line (`... %* & call exit /b %%errorlevel%%`);
  otherwise CMD resumes at a stale offset (`'asoning-effort' is not recognized`).
- PowerShell strips embedded double quotes when calling any `.cmd`; use the `.ps1`.
- Codex reads `M365_PROXY_API_KEY` from the environment; terminals/VS Code started
  before it was set report `Missing environment variable` until restarted.
