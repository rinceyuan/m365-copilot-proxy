import assert from "node:assert/strict";
import test from "node:test";
import { OPUS_CONTEXTS, PROVIDER_NAME, buildProvider, mergeProviders } from "./merge-vscode-models.mjs";

test("routes Claude to Messages and GPT to stateless Responses without a literal key", () => {
  const provider = buildProvider();
  assert.equal(provider.vendor, "customendpoint");
  assert.match(provider.apiKey, /^\$\{input:/);
  const claude = provider.models.filter(model => model.id.startsWith("claude-"));
  const gpt = provider.models.filter(model => model.id.startsWith("gpt-"));
  assert.equal(claude.length, 4 + OPUS_CONTEXTS.length);
  assert.equal(gpt.length, 5);
  for (const model of claude) {
    assert.equal(model.apiType, "messages");
    assert.equal(model.url, "http://127.0.0.1:4141/v1/messages");
  }
  for (const model of gpt) {
    assert.equal(model.apiType, "responses");
    assert.equal(model.statefulResponses, false);
  }
});

test("offers Opus 5.5 in three context sizes inside one group, plain id at the medium size", () => {
  const opus = buildProvider().models.filter(model => model.id.startsWith("claude-opus-5.5"));
  assert.deepEqual(opus.map(model => [model.id, model.contextWindow]), [
    ["claude-opus-5.5", 400000], ["claude-opus-5.5@200k", 200000], ["claude-opus-5.5@1m", 1000000],
  ]);
  assert.equal(new Set(opus.map(model => model.id)).size, 3);
  for (const model of opus) assert.match(model.id, /^claude-opus-5\.5(@\d+[km])?$/);
});

test("preserves other providers, folds legacy groups in, and keeps the stored key reference", () => {
  const copilot = { name: "Copilot", vendor: "copilot", settings: { "gpt-5.4": { reasoningEffort: "high" } } };
  const ref = "${input:chat.lm.secret.5182112b}";
  const legacy = ["M365 Native (4141)", "M365 Opus 200K", "M365 Opus 1M"].map(name => ({ name, vendor: "customendpoint", apiKey: ref, models: [] }));
  const merged = mergeProviders([copilot, ...legacy]);
  assert.equal(PROVIDER_NAME, "M365");
  assert.deepEqual(merged.map(entry => entry.name), ["Copilot", PROVIDER_NAME]);
  assert.deepEqual(merged[0], copilot);
  assert.equal(merged[1].apiKey, ref);
  assert.deepEqual(mergeProviders(merged), merged);
  assert.throws(() => mergeProviders({}), /JSON array/);
});

test("never preserves a literal key", () => {
  const literal = { name: PROVIDER_NAME, vendor: "customendpoint", apiKey: "plaintext-key-value", models: [] };
  assert.equal(mergeProviders([literal])[0].apiKey, "${input:m365ProxyApiKey}");
});
