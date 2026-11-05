# VS Code GitHub Copilot Chat (BYOK Custom Endpoint)

VS Code 1.144+ chat can use the native proxy through the **Custom Endpoint**
provider (`vendor: "customendpoint"`), which selects the API type per model.
Unlike `copilotm`, Claude and GPT models live in one picker and can be switched
inside the same chat: Claude uses native Anthropic Messages, GPT uses Responses.

## Configure

`%APPDATA%\Code\User\chatLanguageModels.json` holds BYOK providers next to the
built-in `Copilot` settings block. Merge the provider with the bundled script
(backs up the file, keeps other providers, replaces only "M365"):

```powershell
node "$skill\scripts\merge-vscode-models.mjs"            # default VS Code user file
node "$skill\scripts\merge-vscode-models.mjs" --file <path>   # e.g. Insiders/profile file
node --test "$skill\scripts\merge-vscode-models.test.mjs"
```

Provider written (10 models, names suffixed `(M365)`):

| Family | `apiType` | URL | Effort format | Limits |
|---|---|---|---|---|
| `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-5.5` | `messages` | `http://127.0.0.1:4141/v1/messages` | `messages` → `output_config.effort` | context 1,000,000; output 32,000 |
| `gpt-61-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-luna` | `responses` | `http://127.0.0.1:4141/v1/responses` | `responses` → `reasoning.effort` | context 1,050,000; output 64,000 |

All models: `toolCalling`, `vision`, `thinking` true; efforts low..max. GPT
models set `statefulResponses: false` because the proxy does not store
responses (full history is sent; no `previous_response_id`). Output limits are
conservative (Claude 32K was observed from Copilot CLI); contexts are the
upstream advertised values, not capacity-tested.

Keep the model list in sync with live `/v1/models` (use the key). Edit the ID
lists in `merge-vscode-models.mjs` when the upstream catalog changes.

### Context sizes for Opus 5.5

VS Code shows a **Context Size** picker only for Copilot-hosted models whose
pricing metadata has a smaller default tier (`tokenPricing.default.contextMax`).
BYOK models use the configured `contextWindow` as a fixed limit, and VS Code
looks up a model's settings by `id` within its group, so one `id` cannot appear
twice. `modelOptions` only overrides `temperature`/`top_p`, not `model`.

The script therefore lists Opus 5.5 three times **in the same group** with
context-variant ids; the proxy (fork `main` after `93372d4`, `upstreamModelId` in
`llmapi.ts`) strips a trailing `@<digits>k|m` before forwarding:

| Model id | Display name | `contextWindow` |
|---|---|---|
| `claude-opus-5.5` | Claude Opus 5.5 (M365, 400K) — default/medium | 400,000 |
| `claude-opus-5.5@200k` | Claude Opus 5.5 (M365, 200K) | 200,000 |
| `claude-opus-5.5@1m` | Claude Opus 5.5 (M365, 1M) | 1,000,000 |

The plain id keeps existing chats on the medium size. A smaller window makes VS
Code summarize history earlier. The fixed agent overhead (system prompt + tools)
was ~57K tokens, plus a 32K output reserve, so ~100K is the practical minimum.
Edit `OPUS_CONTEXTS` to change sizes. Older script versions wrote separate
"M365 Opus 200K/1M" groups; re-running folds them back into the main group.
An older proxy without the suffix rule would forward `claude-opus-5.5@200k`
unchanged and Loki would reject it.
## API key (never write it into the file)

The file uses `"apiKey": "${input:m365ProxyApiKey}"`. The user enters the local
client key once in the UI; VS Code stores it in secret storage and rewrites the
field to its own reference (`${input:chat.lm.secret.<id>}`). The merge script
preserves such a reference on re-runs; it never preserves a literal key.

User steps:

1. Copy the key:
   `Get-Content "$env:LOCALAPPDATA\m365-copilot-proxy\.state\llmapi\client-key" | Set-Clipboard`
2. Open **Chat: Manage Language Models**: `Ctrl+Shift+P` → type
   `Manage Language Models`; or `Ctrl+Alt+I` → model picker → **Manage Language
   Models** (gear).
3. Click the gear beside **M365** and paste the key.
4. Restart VS Code; pick a `(M365)` model; use the `>` next to the model name to
   set thinking effort.

VS Code sends `x-api-key` for Messages and `Authorization: ******
Responses; the proxy accepts both. Requests come from the extension host (no
browser `Origin`), so the proxy's loopback/no-Origin checks pass.

## Scope and limitations

- Copilot Business/Enterprise: the org must enable **Bring Your Own Language
  Model Key in VS Code**; otherwise the group does not appear.
- BYOK models appear in the default Local harness. For Copilot harness sessions
  (Chat view or Agents window) enable `chat.agentHost.byokModels.enabled`.
- Inline completions, semantic search, embeddings and utility tasks (titles,
  commit messages) keep using GitHub Copilot unless `chat.utilityModel` /
  `chat.utilitySmallModel` are pointed at a BYOK model.
- Everything depends on the 4141 proxy (logon task) and the M365 app's Code
  sign-in; 503 `m365_authorization_expired` means reopen the app's Code session.
- Do not enable approval-bypass settings to make BYOK tests pass; the user's
  existing chat approval settings remain theirs.
- **"Autopilot recovered from a request error" ×3 then "Sorry, no response was
  returned" after `task_complete`** (observed 2026-11-03): the answer was already
  delivered and `task_complete` succeeded; VS Code then sends the tool result back,
  Opus replies with an empty `end_turn` (≈2 output tokens). VS Code's
  `ToolCallingLoop` classifies a stream with no text/tool call as
  `unknown` ("Response contained no choices.") and auto-retries (up to
  `MAX_AUTOPILOT_RETRIES` = 3) *before* checking that the task completed; identical
  retries stay empty. Proxy logs show HTTP 200 with a real `message_stop`. This is a
  cosmetic client-side failure; do not synthesize text in the proxy. Diagnose with
  the session's `GitHub.copilot-chat\debug-logs\<session>\main.jsonl`
  (`llm_request` outputTokens, `tool_call task_complete`) and the proxy
  `native_stop` metadata. "Try Again" resends the same history and fails the same way.

## Verification

Simulated VS Code-shaped requests (2026-11-03) passed a full tool round trip:
`claude-opus-5.5` Messages with `x-api-key`, adaptive thinking and
`output_config.effort: high`; `gpt-61-sol` Responses with Bearer key,
`reasoning.effort: high`, `store: false`, function call + output in full
history. The user then entered the key in the UI (VS Code rewrote `apiKey` to a
secret reference). In-editor chat behaviour itself is verified by the user.
