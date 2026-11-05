import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog } from "./build-codex-catalog.mjs";

function fixture() {
  return {
    models: [{
      slug: "gpt-6.1-sol",
      base_instructions: "You are Codex, an agent based on GPT-6. Keep every remaining instruction.",
      model_messages: {
        instructions_template: "You are Codex, an agent based on GPT-6. Keep {{variables}}.",
        persistent_instructions: { mustPreserve: true },
        confirmation_policies: { mustPreserve: true },
      },
      node_repl_auto_review_required: true,
      node_repl_disabled: false,
      tool_mode: "code_mode_only",
      supports_search_tool: true,
      supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
      service_tiers: [{ id: "priority" }],
      additional_speed_tiers: ["fast"],
      availability_nux: { message: "OpenAI availability" },
      use_responses_lite: true,
    }],
  };
}

test("preserves harness policies and changes only the opening identity clause", () => {
  const bundled = fixture();
  const original = structuredClone(bundled);
  const model = buildCatalog(bundled, ["claude-opus-5.5"]).models[0];
  assert.equal(model.base_instructions, "You are Codex, a coding agent. Keep every remaining instruction.");
  assert.equal(model.model_messages.instructions_template, "You are Codex, a coding agent. Keep {{variables}}.");
  for (const key of ["persistent_instructions", "confirmation_policies"]) {
    assert.deepEqual(model.model_messages[key], bundled.models[0].model_messages[key]);
  }
  for (const key of [
    "node_repl_auto_review_required", "node_repl_disabled", "tool_mode",
    "supports_search_tool", "supported_reasoning_levels",
  ]) {
    assert.deepEqual(model[key], bundled.models[0][key]);
  }
  assert.deepEqual(bundled, original);
});

test("exposes canonical models, hides known aliases, and deduplicates IDs", () => {
  const catalog = buildCatalog(fixture(), [
    "claude-opus-5.5", "claude-opus", "claude-opus-5.5", "gpt-6.1-sol",
  ]);
  assert.equal(catalog.models.length, 3);
  assert.equal(catalog.models[0].display_name, "Claude Opus 5.5");
  assert.equal(catalog.models[0].visibility, "list");
  assert.equal(catalog.models[1].visibility, "hide");
  assert.equal(catalog.models[2].display_name, "GPT-6.1 Sol");
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[0].service_tiers, []);
  assert.deepEqual(catalog.models[0].additional_speed_tiers, []);
  assert.equal(catalog.models[0].availability_nux, null);
  assert.equal(catalog.models[0].use_responses_lite, false);
});

test("uses native catalog names and keeps only advertised reasoning levels", () => {
  const bundled = fixture();
  bundled.models[0].default_reasoning_level = "low";
  bundled.models[0].supported_reasoning_levels = ["low", "medium", "max", "ultra"]
    .map(effort => ({ effort, description: effort }));
  const [gpt, claude] = buildCatalog(bundled, [
    { id: "gpt-61-sol", name: "GPT-6.1 Sol", capabilities: { supports: { reasoning_effort: ["medium", "max"] } } },
    { id: "claude-opus-5.5", capabilities: { supports: { reasoning_effort: ["low", "medium", "max"] } } },
  ]).models;
  assert.equal(gpt.display_name, "GPT-6.1 Sol");
  assert.deepEqual(gpt.supported_reasoning_levels.map(level => level.effort), ["medium", "max"]);
  assert.equal(gpt.default_reasoning_level, "medium");
  assert.equal(claude.display_name, "Claude Opus 5.5");
  assert.deepEqual(claude.supported_reasoning_levels.map(level => level.effort), ["low", "medium", "max"]);
  assert.equal(claude.default_reasoning_level, "low");
});

test("keeps an unfamiliar identity intact rather than rewriting unknown instructions", () => {
  const bundled = fixture();
  bundled.models[0].base_instructions = "A future harness with different wording.";
  assert.equal(buildCatalog(bundled, ["claude-opus-5.5"]).models[0].base_instructions,
    bundled.models[0].base_instructions);
});

test("rejects missing templates, missing instructions, and invalid advertised IDs", () => {
  assert.throws(() => buildCatalog({ models: [] }, ["claude-opus-5.5"]), /template not found/);
  assert.throws(() => buildCatalog({ models: [{ slug: "gpt-6.1-sol" }] }, ["auto"]), /instructions/);
  for (const ids of [undefined, [], [""], [null]]) {
    assert.throws(() => buildCatalog(fixture(), ids), /model IDs/);
  }
});
