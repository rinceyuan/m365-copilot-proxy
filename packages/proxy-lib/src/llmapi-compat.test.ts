import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { loadAppManagedProvider } from "./llmapi-app-managed.js";
import { toNativeMessages } from "./llmapi-compat.js";

vi.mock("./llmapi-app-managed.js", async (original) => {
  const module = await original<typeof import("./llmapi-app-managed.js")>();
  return { ...module, loadAppManagedProvider: vi.fn() };
});

const key = "native-client-fixture-".padEnd(64, "x");
const model = "claude-opus-5.5";
const message = (content: unknown[], stop_reason = "end_turn") => ({
  id: "native-message", type: "message", role: "assistant", model, content, stop_reason,
  usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
});
const request = (path: string, body: unknown) => new Request(`http://localhost/v1/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.stubEnv("M365_BACKEND", "llmapi");
  vi.stubEnv("M365_LLMAPI_AUTH", "app-managed");
  vi.stubEnv("M365_LLMAPI_LOCAL_API_KEY", key);
  vi.mocked(loadAppManagedProvider).mockResolvedValue({
    headers: { "X-ClientScenario": "Code", "X-ClientType": "Copilot", "X-ClientFeature": "LlmApiProxy", "X-Llm-Api-Version": "2026-09-22" },
    getToken: () => "native-upstream-fixture", dispose: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stream(terminal: boolean) {
  const events = [
    { type: "message_start", message: { ...message([]), usage: { input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\u4f60\u597d" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ...(terminal ? [{ type: "message_stop" }] : []),
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("native Claude compatibility", () => {
  it("uses the same model's native endpoint for Chat without prompt-emulated tools", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(message([{ type: "text", text: "ok" }]))));
    vi.stubGlobal("fetch", fetch);
    const response = await createApp().fetch(request("chat/completions", {
      model, messages: [{ role: "user", content: "ok" }], reasoning_effort: "xhigh",
    }));
    expect(response.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[0][1].body));
    expect(fetch.mock.calls[0][0]).toBe("https://loki.delve.office.com/api/v1/llmapi/v1/messages");
    expect(body).toMatchObject({ model, thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect((await response.json()).choices[0].message.content).toBe("ok");
  });

  it("round-trips signed thinking and native tool results through Responses", async () => {
    const thinking = { type: "thinking", thinking: "fixture thought", signature: "original-native-signature" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(message([
        thinking, { type: "tool_use", id: "call_one", name: "lookup", input: {} },
      ], "tool_use"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(message([{ type: "text", text: "fixture result" }]))));
    vi.stubGlobal("fetch", fetch);
    const base = { model, reasoning: { effort: "max" }, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] };
    const first = await (await createApp().fetch(request("responses", { ...base, input: "Read the fixture" }))).json();
    expect(first.output.map((item: any) => item.type)).toEqual(["reasoning", "function_call"]);
    const second = await createApp().fetch(request("responses", {
      ...base, input: [
        { role: "user", content: "Read the fixture" }, ...first.output,
        { type: "function_call_output", call_id: "call_one", output: "fixture result" },
      ],
    }));
    expect(second.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[1][1].body));
    expect(body.messages[1].content[0]).toEqual(thinking);
    expect(body.messages[1].content[1]).toMatchObject({ type: "tool_use", id: "call_one", name: "lookup" });
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_one" });
    expect(body.output_config.effort).toBe("max");
    expect((await second.json()).output[0].content[0].text).toBe("fixture result");
  });

  it("maps qualified tool names reversibly without corrupting native tool IDs", () => {
    const name = "custom.functions.exec_command";
    const { body, names } = toNativeMessages({
      model, messages: [
        { role: "assistant", tool_calls: [{ id: "actual_call", type: "function", function: { name, arguments: '{"content":"pwd"}' } }] },
        { role: "tool", tool_call_id: "actual_call", content: "result" },
      ],
      tools: [{ type: "function", function: { name, parameters: { type: "object" } } }],
    });
    expect(body.tools[0].name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(names.get(body.tools[0].name)).toBe(name);
    expect(body.messages[0].content[0]).toMatchObject({ id: "actual_call", name: body.tools[0].name });
    expect(body.messages[1].content[0].tool_use_id).toBe("actual_call");
  });

  it.each([true, false])("only completes a Responses stream after the real native terminal (%s)", async (terminal) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(terminal)));
    const response = await createApp().fetch(request("responses", { model, input: "hi", stream: true }));
    const text = await response.text();
    expect(text).toContain("\u4f60\u597d");
    expect(text.includes('"type":"response.completed"')).toBe(terminal);
    expect(text.includes('"type":"response.failed"')).toBe(!terminal);
  });

  it("preserves upstream failures and retry guidance without retries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"code":"native_throttle"}}', {
      status: 429, headers: { "Retry-After": "9" },
    }));
    vi.stubGlobal("fetch", fetch);
    const response = await createApp().fetch(request("responses", { model, input: "hi" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect((await response.json()).error.code).toBe("native_throttle");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
