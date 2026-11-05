// Merge the "M365" Custom Endpoint provider into VS Code's chatLanguageModels.json.
// Other providers are preserved; an existing provider with the same name is replaced.
// The API key is never written: VS Code resolves ${input:m365ProxyApiKey} into its secret storage.
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER_NAME = "M365";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE = [
  ["claude-opus-5.5", "Claude Opus 5.5"], ["claude-sonnet-5.5", "Claude Sonnet 5.5"],
  ["claude-opus-5", "Claude Opus 5"], ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-5.5", "Claude Haiku 5.5"],
];
const GPT = [
  ["gpt-61-sol", "GPT-6.1 Sol"], ["gpt-6-sol", "GPT-6 Sol"], ["gpt-6-luna", "GPT-6 Luna"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"], ["gpt-5.6-luna", "GPT-5.6 Luna"],
];

// VS Code has no context-size picker for BYOK models and looks up a model's settings by id
// within its group, so extra Opus 5.5 context sizes use "<model>@<size>" ids. The proxy strips
// the suffix before forwarding (upstreamModelId in llmapi.ts). The plain id is the default size.
export const OPUS_CONTEXTS = [
  { suffix: "", label: "400K", contextWindow: 400000 },
  { suffix: "@200k", label: "200K", contextWindow: 200000 },
  { suffix: "@1m", label: "1M", contextWindow: 1000000 },
];
// Groups written by an earlier version of this script; merged into the main group.
const LEGACY_GROUPS = ["M365 Native (4141)", "M365 Opus 200K", "M365 Opus 1M"];
const DEFAULT_KEY = "${input:m365ProxyApiKey}";

function claudeModel(base, id, name, contextWindow, label) {
  return {
    id, name: label ? `${name} (M365, ${label})` : `${name} (M365)`, url: `${base}/v1/messages`,
    apiType: "messages", toolCalling: true, vision: true, thinking: true, supportsReasoningEffort: EFFORTS,
    contextWindow, maxOutputTokens: 32000, reasoningEffortFormat: "messages",
  };
}

export function buildProvider(base = "http://127.0.0.1:4141") {
  const common = { toolCalling: true, vision: true, thinking: true, supportsReasoningEffort: EFFORTS };
  return {
    name: PROVIDER_NAME,
    vendor: "customendpoint",
    apiKey: DEFAULT_KEY,
    models: [
      ...CLAUDE.flatMap(([id, name]) => id === "claude-opus-5.5"
        ? OPUS_CONTEXTS.map(size => claudeModel(base, `${id}${size.suffix}`, name, size.contextWindow, size.label))
        : [claudeModel(base, id, name, 1000000)]),
      ...GPT.map(([id, name]) => ({
        id, name: `${name} (M365)`, url: `${base}/v1/responses`, apiType: "responses",
        statefulResponses: false, ...common,
        contextWindow: 1050000, maxOutputTokens: 64000, reasoningEffortFormat: "responses",
      })),
    ],
  };
}

const isStoredRef = value => typeof value === "string" && /^\$\{input:[^}]+\}$/.test(value) && value !== DEFAULT_KEY;

export function mergeProviders(existing, provider = buildProvider()) {
  if (!Array.isArray(existing)) throw new Error("chatLanguageModels.json must contain a JSON array.");
  // After the key is entered in the UI, VS Code rewrites apiKey to its own secret-storage
  // reference; keep it so a re-merge does not force the user to re-enter the key.
  // Literal keys are never preserved.
  const replaced = new Set([provider.name, ...LEGACY_GROUPS]);
  const stored = [provider.name, ...LEGACY_GROUPS]
    .map(name => existing.find(entry => entry?.name === name)?.apiKey)
    .find(isStoredRef);
  return [...existing.filter(entry => !replaced.has(entry?.name)), { ...provider, apiKey: stored ?? provider.apiKey }];
}

function main(args) {
  const fileIndex = args.indexOf("--file");
  const file = fileIndex >= 0 ? args[fileIndex + 1]
    : join(process.env.APPDATA ?? "", "Code", "User", "chatLanguageModels.json");
  if (!file) throw new Error("--file requires a path.");
  let existing = [];
  if (existsSync(file)) {
    existing = JSON.parse(readFileSync(file, "utf8"));
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    copyFileSync(file, `${file}.${stamp}.bak`);
  }
  const merged = mergeProviders(existing);
  writeFileSync(file, `${JSON.stringify(merged, null, "\t")}\n`);
  console.log(`Providers: ${merged.map(entry => entry.name).join(", ")} (${file})`);
}

function isEntryPoint() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
