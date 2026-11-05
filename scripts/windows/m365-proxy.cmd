@echo off
setlocal
set "HOST=127.0.0.1"
set "NITRO_HOST=127.0.0.1"
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "NODE_USE_ENV_PROXY=1"
set "M365_BACKEND=llmapi"
set "M365_LLMAPI_AUTH=app-managed"
set "M365_LLMAPI_API_KEY_FILE=%LOCALAPPDATA%\m365-copilot-proxy\.state\llmapi\client-key"
set "M365_LLMAPI_TOKEN="
set "M365_ENABLE_INTERACTIVE_APPROVAL="
set "M365_OPUS_FALLBACK_MODEL="
set "M365_DEBUG=1"
set "M365_TRACE="
set "M365_LOG_FILE=%LOCALAPPDATA%\m365-copilot-proxy\.state\llmapi\native-diagnostics.log"
>&2 echo M365 native proxy: app-managed Code authorization; no Sydney or model fallback.
"%LOCALAPPDATA%\m365-copilot-proxy\node-v24.22.2-win-x64\node.exe" --require "%USERPROFILE%\.local\bin\m365-proxy-auto-egress.cjs" "%USERPROFILE%\repos\m365-copilot-proxy\packages\proxy\bin\m365-proxy.mjs" %* & call exit /b %%errorlevel%%
