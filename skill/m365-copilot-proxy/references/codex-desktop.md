# Codex desktop model catalog (native backend)

## Why a local catalog

Codex's picker needs model metadata plus model-owned harness instructions; the
proxy's `/v1/models` only returns Loki's catalog (IDs, names, endpoints, efforts).
A local `model_catalog_json` built from Codex's own bundled template exposes the
native IDs without inventing instructions.

A catalog generated for the old Sydney backend lists IDs that do not exist
natively (`gpt-6.1-sol`, `claude-opus-4.8`, `*-think-deeper`, `*-quick`). Native
IDs are e.g. `gpt-61-sol`, `claude-opus-5.5`. Regenerate after any backend switch
or when `/models` changes.

## Generate from the exact installed backend

The desktop app can bundle a different Codex backend than PATH's `codex`. Find it
without dumping command lines:

```powershell
Get-Process -Name codex -ErrorAction SilentlyContinue | Select-Object Id, Path
```

Set `$desktopCodex` to that executable (or `codex.exe` for CLI-only). The helper
reads `/v1/models` from the loopback proxy, sending the local key (from
`M365_PROXY_API_KEY` or the key file; never to non-loopback URLs), exports
`debug models --bundled`, and refuses to overwrite an existing output.

```powershell
$skill = Join-Path $env:USERPROFILE '.copilot\skills\m365-copilot-proxy'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$generated = Join-Path $codexHome 'm365.models.generated.json'
node "$skill\scripts\build-codex-catalog.mjs" --codex $desktopCodex --output $generated
```

Per model it clones the bundled `gpt-6.1-sol` template (`--template` to change),
uses the upstream `name` as display name, keeps only template reasoning levels
that the upstream advertises (drops Codex-only `ultra`; default becomes `medium`
if the template default is unsupported), and replaces only the known opening
identity sentence. It keeps the template context window (conservative; upstream
advertises 1M/1.05M), harness policies, discovery support and review controls.

Verify before installing: every slug is advertised by `/models`; names and
levels look right; `base_instructions` / `model_messages` retain full bodies;
`tool_mode`, `supports_search_tool`, `node_repl_*` match the template.

```powershell
$target = Join-Path $codexHome 'm365.models.json'
if (Test-Path $target) { Copy-Item $target "$target.$(Get-Date -Format yyyyMMdd-HHmmss).bak" }
Move-Item $generated $target -Force
```

Reference it from `config.toml` with an absolute path (TOML does not expand
variables): `model_catalog_json = 'C:\Users\<user>\.codex\m365.models.json'`.
Keep `web_search` disabled: the proxy implements no hosted tools. Fully restart
the desktop app and start a new chat. If UI automation is denied, ask the user.

## Validation

```powershell
node --test "$skill\scripts\build-codex-catalog.test.mjs"
codex debug models
codex exec --skip-git-repo-check -m gpt-61-sol 'Reply only CODEX_OK. Do not run commands.'
```

For backend-level checks, a separately started app-server accepts
newline-delimited JSON-RPC: `initialize` (`experimentalApi: true`),
`initialized`, `model/list`, `thread/start` (owned dir, `ephemeral: true`),
`turn/start`. Never auto-approve permission requests; close all stdio of the
owned process afterwards.

## Tool and error diagnosis

- Responses requests for GPT pass through to Loki unchanged; Claude requests are
  adapted to native Messages with native `tool_use`/`tool_result` (function,
  namespace and custom tools). Unsupported tool types fail with an explicit
  message; inspect the actual rejected type rather than stripping tools.
- `endpoint_model_mismatch` / "does not support endpoint": a client used the wrong
  protocol for that family (e.g. Anthropic Messages for a GPT ID).
- "No active route ... serving capacity": upstream capacity for that GPT model;
  Codex shows `Reconnecting... n/5`. Retry later; do not silently switch models.
- `content_filter` / native `refusal`: a real upstream refusal. Check
  `native-diagnostics.log` for `native_stop` metadata; do not alter moderation or
  replay sensitive history to reproduce it.
- `Missing environment variable: M365_PROXY_API_KEY`: the process started before
  the user variable was set; restart it.
- Hosted `web_search`, `previous_response_id` storage, background jobs and
  WebSocket transport are not provided by the proxy.
