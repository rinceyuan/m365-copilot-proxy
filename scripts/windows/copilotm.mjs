// copilotm: Copilot CLI through the local M365 native proxy.
// Claude models use native Anthropic Messages; other models (GPT) use OpenAI Responses,
// because the upstream catalog only exposes each family on that endpoint.
import { spawn } from "node:child_process";
import path from "node:path";

const PROXY = "http://127.0.0.1:4141";
const DEFAULT_MODEL = "claude-opus-5.5";
const DEFAULT_EFFORT = "high";

const args = process.argv.slice(2);

function optionValue(names) {
  let value;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    for (const name of names) {
      if (arg === name && i + 1 < args.length) value = args[i + 1];
      else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    }
  }
  return value;
}

try {
  const health = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`HTTP ${health.status}`);
} catch {
  console.error(`M365 proxy is not responding at ${PROXY}.`);
  console.error("Start it first: m365-proxy 4141 (or the \"M365 Native Proxy 4141\" scheduled task)");
  process.exit(1);
}

const model = optionValue(["--model"]) ?? DEFAULT_MODEL;
const anthropic = model.toLowerCase().startsWith("claude-");
const prefix = [];
if (optionValue(["--model"]) === undefined) prefix.push("--model", DEFAULT_MODEL);
if (optionValue(["--reasoning-effort"]) === undefined) prefix.push("--reasoning-effort", DEFAULT_EFFORT);

const env = { ...process.env };
for (const name of [
  "COPILOT_MODEL", "COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL",
  "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN", "COPILOT_PROVIDER_HEADERS",
]) delete env[name];
Object.assign(env, {
  COPILOT_PROVIDER_TYPE: anthropic ? "anthropic" : "openai",
  COPILOT_PROVIDER_BASE_URL: anthropic ? PROXY : `${PROXY}/v1`,
  COPILOT_PROVIDER_TRANSPORT: "http",
  COPILOT_PROVIDER_API_KEY_COMMAND: `"${process.execPath}" "${path.join(
    process.env.USERPROFILE ?? "", "repos", "m365-copilot-proxy", "packages", "proxy", "bin", "llmapi-key.mjs",
  )}"`,
});
if (anthropic) delete env.COPILOT_PROVIDER_WIRE_API;
else env.COPILOT_PROVIDER_WIRE_API = "responses";

// Ctrl+C reaches every process on the console; let copilot.exe handle it and exit.
for (const signal of ["SIGINT", "SIGBREAK"]) process.on(signal, () => {});

const child = spawn("copilot.exe", [...prefix, ...args], { stdio: "inherit", env });
child.on("error", (err) => {
  console.error(`Failed to start copilot.exe: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
