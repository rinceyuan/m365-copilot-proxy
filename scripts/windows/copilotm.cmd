@echo off
rem Routes claude-* to native Anthropic Messages and other models (GPT) to OpenAI Responses; see copilotm.mjs.
"%LOCALAPPDATA%\m365-copilot-proxy\node-v24.22.2-win-x64\node.exe" "%~dp0copilotm.mjs" %* & call exit /b %%errorlevel%%
