import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Legacy Sydney aliases stay hidden if a SignalR backend is ever cataloged.
const hiddenAliases = new Set([
  "auto", "quick", "think-deeper", "claude", "claude-sonnet",
  "claude-sonnet-4.5", "claude-opus", "claude-opus-4.5",
  "gpt-5.5-quick", "gpt-5.6-quick", "gpt-5.4-think-deeper",
  "gpt-5.3-quick", "gpt-5.2-quick",
]);
const priorities = new Map([
  ["claude-opus-5.5", 0], ["gpt-61-sol", 1], ["claude-sonnet-5.5", 2],
  ["gpt-6-sol", 3], ["claude-opus-5", 4], ["gpt-6-luna", 5],
]);
const identity = "You are Codex, an agent based on GPT-6.";

function neutralIdentity(text) {
  return typeof text === "string" && text.startsWith(identity)
    ? `You are Codex, a coding agent.${text.slice(identity.length)}`
    : text;
}

function displayName(id) {
  if (id === "m365-copilot") return "M365 Copilot Auto";
  if (hiddenAliases.has(id)) return id;
  if (id.startsWith("gpt-")) {
    const [version, ...suffix] = id.slice(4).split("-");
    return `GPT-${version}${suffix.length ? ` ${suffix.map(title).join(" ")}` : ""}`;
  }
  return id.split("-").map(title).join(" ");
}

function title(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Accepts plain IDs or upstream catalog entries ({ id, name, capabilities }). */
export function buildCatalog(bundled, entries, templateSlug = "gpt-6.1-sol") {
  const template = bundled?.models?.find(model => model.slug === templateSlug);
  if (!template) throw new Error(`Bundled template not found: ${templateSlug}`);
  if (!template.base_instructions && !template.model_messages?.instructions_template) {
    throw new Error("Bundled template has no model-owned instructions.");
  }
  const advertised = Array.isArray(entries)
    ? entries.map(entry => (typeof entry === "string" ? { id: entry } : entry))
    : entries;
  if (!Array.isArray(advertised) || !advertised.length ||
      advertised.some(entry => typeof entry?.id !== "string" || !entry.id.trim())) {
    throw new Error("The proxy must advertise nonempty string model IDs.");
  }
  const unique = [...new Map(advertised.map(entry => [entry.id, entry])).values()];
  return {
    models: unique.map((entry, index) => {
      const id = entry.id;
      const model = structuredClone(template);
      model.slug = id;
      model.display_name = typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim() : displayName(id);
      const efforts = entry.capabilities?.supports?.reasoning_effort;
      if (Array.isArray(efforts) && Array.isArray(model.supported_reasoning_levels)) {
        const levels = model.supported_reasoning_levels.filter(level => efforts.includes(level.effort));
        if (levels.length) {
          model.supported_reasoning_levels = levels;
          if (!levels.some(level => level.effort === model.default_reasoning_level)) {
            model.default_reasoning_level =
              (levels.find(level => level.effort === "medium") ?? levels[0]).effort;
          }
        }
      }
      model.description = `${model.display_name} through the local M365 Copilot proxy.`;
      model.visibility = hiddenAliases.has(id) ? "hide" : "list";
      model.priority = priorities.get(id) ?? 20 + index;
      model.supported_in_api = true;
      model.upgrade = null;
      model.availability_nux = null;
      model.additional_speed_tiers = [];
      model.service_tiers = [];
      model.use_responses_lite = false;
      model.input_modalities = ["text", "image"];
      model.base_instructions = neutralIdentity(model.base_instructions);
      if (model.model_messages?.instructions_template) {
        model.model_messages.instructions_template =
          neutralIdentity(model.model_messages.instructions_template);
      }
      return model;
    }),
  };
}

// Native app-managed mode requires the local client key; the key is sent only to the loopback proxy.
function localKeyHeaders(url) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) return {};
  let key = process.env.M365_PROXY_API_KEY;
  if (!key) {
    const file = process.env.M365_LLMAPI_API_KEY_FILE ??
      join(process.env.LOCALAPPDATA ?? "", "m365-copilot-proxy", ".state", "llmapi", "client-key");
    try { key = readFileSync(file, "utf8").trim(); } catch { key = ""; }
  }
  return key ? { "x-api-key": key } : {};
}

async function main(args) {
  const options = {
    "--codex": "codex.exe",
    "--base-url": "http://127.0.0.1:4141/v1",
    "--template": "gpt-6.1-sol",
  };
  if (args.includes("--help")) {
    console.log("Usage: node build-codex-catalog.mjs --output <new-file> [--codex <exe>] [--base-url <url>] [--template <slug>]");
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!["--codex", "--base-url", "--template", "--output"].includes(args[i]) ||
        !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid option or missing value: ${args[i]}`);
    }
    options[args[i]] = args[i + 1];
  }
  if (!options["--output"]) throw new Error("--output is required; existing files are never overwritten.");
  const dump = spawnSync(options["--codex"], ["debug", "models", "--bundled"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (dump.error) throw dump.error;
  if (dump.status !== 0) throw new Error(`Codex bundled model export failed (exit ${dump.status}).`);
  const modelsUrl = `${options["--base-url"].replace(/\/$/, "")}/models`;
  const response = await fetch(modelsUrl, {
    headers: localKeyHeaders(modelsUrl),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Proxy model discovery failed (HTTP ${response.status}).`);
  const advertised = await response.json();
  const catalog = buildCatalog(JSON.parse(dump.stdout), advertised.data, options["--template"]);
  const output = resolve(options["--output"]);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
  console.log(`Created ${catalog.models.length} models (${catalog.models.filter(model => model.visibility === "list").length} visible): ${output}`);
}

if (process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
