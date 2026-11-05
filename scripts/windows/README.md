# Windows Native Proxy Launchers & Auto-Egress Scripts

This directory contains the Windows launcher, background autostart, authorization guard, and dynamic proxy/direct egress scripts used to run the local M365 native LLMAPI proxy on `http://127.0.0.1:4141`.

## Overview of Files

| File | Installed Path (`%USERPROFILE%\.local\bin\`) | Purpose |
| --- | --- | --- |
| `m365-proxy.cmd` | `m365-proxy.cmd` | Starts the local native `llmapi` server on `127.0.0.1:4141` with app-managed DPAPI authorization and preloads `m365-proxy-auto-egress.cjs`. |
| `m365-proxy-auto-egress.cjs` | `m365-proxy-auto-egress.cjs` | CommonJS preload module (`--require`) that dynamically switches Node's Undici `fetch` dispatcher between the local Clash proxy (`127.0.0.1:7897`) and a direct connection (`DIRECT`) per request without restarting the server. |
| `m365-proxy-autostart.vbs` | `m365-proxy-autostart.vbs` | Windowless WScript wrapper invoked by the `M365 Native Proxy 4141` scheduled task at user logon. Checks `http://127.0.0.1:4141/health` first and starts `m365-proxy.cmd` only if not already running. |
| `m365-proxy-auth-guard.mjs` | `m365-proxy-auth-guard.mjs` | Periodic health & authorization monitor. Probes `/v1/models` and opens the installed M365 Copilot desktop app (`m365-code.lnk`) with a 1-hour cooldown when `503 m365_authorization_expired` is detected. |
| `m365-proxy-auth-guard.vbs` | `m365-proxy-auth-guard.vbs` | Windowless WScript wrapper used by the `M365 Proxy Authorization Guard` scheduled task. |
| `install-auth-guard.ps1` | *(Installer script)* | Installs the authorization guard scripts and registers the `M365 Proxy Authorization Guard` scheduled task. |
| `copilotm.cmd` / `copilotm.ps1` / `copilotm.mjs` | `copilotm.*` | CLI wrapper for `copilot.exe` that routes `claude-*` models to the native Anthropic Messages endpoint (`http://127.0.0.1:4141`) and GPT models to the OpenAI Responses endpoint (`http://127.0.0.1:4141/v1`). |

## Dynamic Proxy / Direct Auto-Egress (`m365-proxy-auto-egress.cjs`)

Upstream `loki.delve.office.com` enforces regional availability by egress IP:
- **Via overseas proxy (`127.0.0.1:7897`)**: Exposes all 10 models (5 Claude models including `claude-opus-5.5` + 5 GPT models).
- **Via direct connection (`DIRECT`)**: Exposes the 5 GPT models (`gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-6-luna`, `gpt-6-sol`, `gpt-61-sol`), while Claude models return `403 model_not_allowed`.

When `NODE_USE_ENV_PROXY=1` and `HTTP_PROXY=http://127.0.0.1:7897` are set unconditionally, closing Clash Verge causes Node's default `EnvHttpProxyAgent` to fail all outbound requests with `ECONNREFUSED 127.0.0.1:7897`—breaking even the GPT models that work over a direct connection.

`m365-proxy-auto-egress.cjs` solves this at runtime:
1. Lazily captures both Undici's `EnvHttpProxyAgent` (`proxyDispatcher`) and its internal `Symbol(no proxy agent)` direct `Agent` (`directDispatcher`).
2. Before each outbound `fetch()`, probes `127.0.0.1:7897` (150 ms timeout, cached for 2 seconds):
   - **Reachable (`PROXY` mode)**: Routes outbound requests through `127.0.0.1:7897` so both Claude and GPT models are available.
   - **Unreachable (`DIRECT` mode)**: Routes outbound requests directly without a proxy so `/v1/models` and all GPT models continue working when Clash Verge is closed.
3. If Clash Verge closes mid-window and a proxied `fetch()` throws `ECONNREFUSED` or `ECONNRESET`, it immediately invalidates the probe cache, switches to `DIRECT`, and retries the request once.

## Clash Verge & Windows WAM (`Microsoft.AAD.BrokerPlugin`) Coexistence

When running Clash Verge on Windows with System Proxy enabled (`ProxyEnable = 1`):
- Windows Web Account Manager (`Microsoft.AAD.BrokerPlugin_cw5n1h2txyewy`, used by Git Credential Manager, VS Code, Office, and M365 Copilot) runs inside a UWP AppContainer.
- Windows kernel loopback isolation blocks UWP AppContainers from connecting to `127.0.0.1:7897`, causing WAM authentication to fail with `WAM Error 3399942148 (NoNetwork)` unless Microsoft domains bypass the system proxy.
- Configure Clash Verge (`verge.yaml`) with `use_default_bypass: false` and include Microsoft authentication and service domains in `system_proxy_bypass` (and Windows `ProxyOverride`):
  ```text
  localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;*.local;*.microsoftonline.com;*.microsoft.com;*.live.com;*.msauth.net;*.msftauth.net;*.msidentity.com;*.microsoftazuread-sso.com;*.windows.net;*.office.com;*.office365.com;*.office.net;*.cloud.microsoft;*.static.microsoft;*.azure.com;*.azure.net;*.visualstudio.com;*.vsassets.io;*.sfx.ms;*.sharepoint.com;*.onedrive.com;*.bing.com;*.aka.ms;<local>
  ```
- In Clash Verge global Prepend Rules, keep `DOMAIN,loki.delve.office.com,PROXY` first, followed by `DOMAIN-SUFFIX,<microsoft-domain>,DIRECT` rules so `loki.delve.office.com` uses the proxy while all Microsoft login/corporate traffic goes direct.
