# Agent Skill: `m365-copilot-proxy`

This directory contains the reusable agent skill (`skill/m365-copilot-proxy/`) for installing, maintaining, and troubleshooting the `m365-copilot-proxy` native LLMAPI (`loki.delve.office.com/api/v1/llmapi`) backend on Windows, along with client integrations for GitHub Copilot CLI (`copilotm`), OpenAI Codex CLI/Desktop, and VS Code Copilot Chat (BYOK Custom Endpoint).

## Directory Layout

- `m365-copilot-proxy/SKILL.md` — Main skill entrypoint, workflow, invariants, and acceptance checks.
- `m365-copilot-proxy/references/`
  - `windows-setup.md` — Step-by-step Windows setup guide, scheduled tasks, launchers, and proxy coexistence notes.
  - `codex-desktop.md` — Codex CLI and Codex Desktop model catalog configuration.
  - `vscode-copilot.md` — VS Code Copilot Chat Custom Endpoint (`chatLanguageModels.json`) setup and usage.
  - `compatibility-baseline.json` — Verified runtime versions, upstream endpoints, and test baseline metadata.
- `m365-copilot-proxy/scripts/`
  - `build-codex-catalog.mjs` & `build-codex-catalog.test.mjs` — Generates the Codex Desktop model catalog from live `/v1/models` output.
  - `merge-vscode-models.mjs` & `merge-vscode-models.test.mjs` — Merges the `M365` Custom Endpoint provider into VS Code's `chatLanguageModels.json`.
  - `install-auth-guard.ps1` & `m365-proxy-auth-guard.test.mjs` — Installs and tests the scheduled authorization guard task.
- `m365-copilot-proxy/templates/`
  - Windows launcher and runtime templates (`m365-proxy.cmd`, `m365-proxy-auto-egress.cjs`, `m365-proxy-autostart.vbs`, `m365-proxy-auth-guard.mjs`, `m365-proxy-auth-guard.vbs`, `copilotm.cmd`, `copilotm.ps1`, `copilotm.mjs`).

## Installation

Copy `skill/m365-copilot-proxy` into your agent skills directory (for example, `~/.copilot/skills/m365-copilot-proxy` for GitHub Copilot CLI):

```powershell
Copy-Item -Path .\skill\m365-copilot-proxy -Destination "$HOME\.copilot\skills\m365-copilot-proxy" -Recurse -Force
```
