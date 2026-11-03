import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./handler.js", () => ({
  SessionPool: class {},
  handleChatCompletion: vi.fn(),
}));

import { handleChatCompletion, SessionPool } from "./handler.js";
import { createApp } from "./index.js";
import { handleResponses, ResponsesRequest } from "./responses.js";

const chat = vi.mocked(handleChatCompletion);
const encoder = new TextEncoder();
const functionTool = { type: "function", name: "lookup", parameters: { type: "object" } };
const customTool = { type: "custom", name: "exec", description: "Execute JavaScript." };
const toolCall = (name = "lookup", args = '{"value":1}') => ({
  id: "call_1", type: "function", function: { name, arguments: args },
});
const chunk = (delta: unknown, finish_reason: string | null = null) => ({
  model: "test-model", choices: [{ index: 0, delta, finish_reason }],
});

function completion(message: unknown, finish_reason = "stop") {
  return Response.json({
    model: "test-model",
    choices: [{ index: 0, message, finish_reason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, x_m365_quota_percent: 1 },
  });
}

function stream(chunks: unknown[], done = true, splitBytes = false) {
  const text = chunks.map((data) => `data: ${JSON.stringify(data)}\r\n\r\n`).join("")
    + (done ? "data: [DONE]\r\n\r\n" : "");
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitBytes) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      } else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function respond(overrides: Record<string, unknown> = {}) {
  return handleResponses(ResponsesRequest.parse({ model: "test-model", input: "Hello", ...overrides }), new SessionPool());
}

async function events(response: Response) {
  return (await response.text()).split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

beforeEach(() => {
  chat.mockReset();
  chat.mockResolvedValue(completion({ content: "Hello" }));
});

describe("Responses input conversion", () => {
  it("includes the actual Codex prompt, not just environment context, in the conversation opener", async () => {
    await respond({ input: [
      { role: "user", content: "Environment: the same working directory" },
      { role: "user", content: [{ type: "input_text", text: "The actual task" }] },
    ] });
    expect(chat.mock.calls[0][0].messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "Environment: the same working directory" }, { type: "text", text: "The actual task" }],
    }]);
  });

  it("translates instructions, developer messages, images, and function tool history", async () => {
    await respond({
      instructions: "Follow these instructions.",
      tools: [functionTool],
      tool_choice: { type: "function", name: "lookup" },
      max_output_tokens: 20,
      input: [
        { role: "developer", content: "Developer instructions." },
        { role: "user", content: [{ type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,abc" }] },
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"value":1}' },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Result" }] },
      ],
    });
    expect(chat.mock.calls[0][0]).toMatchObject({
      model: "test-model",
      max_tokens: 20,
      tool_choice: { type: "function", function: { name: "lookup" } },
      messages: [
        { role: "system", content: "Follow these instructions." },
        { role: "system", content: "Developer instructions." },
        { role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
        { role: "assistant", tool_calls: [toolCall()] },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "Result" }] },
      ],
    });
  });

  it("reads Codex inline namespaces and round-trips custom input without shell aliasing", async () => {
    chat.mockResolvedValue(completion({ content: null, tool_calls: [toolCall("custom.functions.exec", '{"content":"console.log(5)"}')] }, "tool_calls"));
    const response = await respond({
      input: [
        { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [customTool] }] },
        { role: "user", content: "Calculate" },
        { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "prior", input: "console.log(3)" },
        { type: "custom_tool_call_output", call_id: "prior", output: "3" },
      ],
    });
    const request = chat.mock.calls[0][0];
    expect(request.tools?.[0].function).toMatchObject({
      name: "custom.functions.exec",
      parameters: { properties: { content: { type: "string" } } },
    });
    expect(request.messages[1].tool_calls?.[0].function.arguments).toBe('{"content":"console.log(3)"}');
    expect((await response.json()).output[0]).toMatchObject({
      type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "call_1", input: "console.log(5)", status: "completed",
    });
  });

  it("keeps identically named functions in distinct namespaces separate", async () => {
    chat.mockResolvedValue(completion({ content: null, tool_calls: [toolCall("second.lookup")] }, "tool_calls"));
    const response = await respond({
      tools: [
        { type: "namespace", name: "first", tools: [functionTool] },
        { type: "namespace", name: "second", tools: [functionTool] },
      ],
    });
    expect(chat.mock.calls[0][0].tools?.map((tool) => tool.function.name)).toEqual(["first.lookup", "second.lookup"]);
    expect((await response.json()).output[0]).toMatchObject({ type: "function_call", namespace: "second", name: "lookup", arguments: '{"value":1}' });
  });

  it.each([
    { previous_response_id: "resp_prior" },
    { background: true },
  ])("rejects unsupported server-side state before contacting M365: %j", async (options) => {
    const response = await respond(options);
    expect(response.status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("Responses output conversion", () => {
  it("returns a complete JSON response and maps usage", async () => {
    const result = await (await respond()).json();
    expect(result).toMatchObject({
      object: "response", status: "completed", store: false, error: null,
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, x_m365_quota_percent: 1 },
    });
  });

  it("decodes split UTF-8/CRLF frames and emits ordered text lifecycle events", async () => {
    chat.mockResolvedValue(stream([
      chunk({ role: "assistant" }),
      chunk({ content: "你好" }),
      chunk({ content: " world" }),
      { ...chunk({}, "stop"), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ], true, true));
    const result = await events(await respond({ stream: true }));
    expect(result[0].type).toBe("response.created");
    expect(result.map((event) => event.sequence_number)).toEqual(result.map((_, index) => index));
    expect(result.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta)).toEqual(["你好", " world"]);
    expect(result.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed", output: [{ content: [{ text: "你好 world" }] }], usage: { input_tokens: 4, total_tokens: 6 } },
    });
    expect(result.findIndex((event) => event.type === "response.content_part.added")).toBeLessThan(result.findIndex((event) => event.type === "response.output_text.delta"));
    expect(result.some((event) => event.type === "response.output_item.done")).toBe(true);
  });

  it("forwards the first text delta before upstream completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    chat.mockResolvedValue(new Response(new ReadableStream({
      start(value) { controller = value; },
    })));
    const response = await respond({ stream: true });
    const reader = response.body!.getReader();
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: "first" }))}\n\n`));
    let received = "";
    while (!received.includes("response.output_text.delta")) {
      received += new TextDecoder().decode((await reader.read()).value);
    }
    expect(received).toContain('"delta":"first"');
    await reader.cancel();
    expect(chat.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });

  it("converts fragmented function arguments and preserves the tool identity", async () => {
    chat.mockResolvedValue(stream([
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"value":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
      chunk({}, "tool_calls"),
    ]));
    const result = await events(await respond({ stream: true, tools: [functionTool] }));
    expect(result.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta)).toEqual(['{"value":', "1}"]);
    expect(result.at(-1).response.output[0]).toMatchObject({ type: "function_call", name: "lookup", call_id: "call_1", arguments: '{"value":1}' });
  });

  it("unwraps custom tool arguments into raw custom-tool events", async () => {
    chat.mockResolvedValue(stream([
      chunk({ tool_calls: [{ index: 0, ...toolCall("custom.functions.exec", '{"content":"line1\\nline2"}') }] }),
      chunk({}, "tool_calls"),
    ]));
    const result = await events(await respond({ stream: true, tools: [{ type: "namespace", name: "functions", tools: [customTool] }] }));
    expect(result.find((event) => event.type === "response.custom_tool_call_input.delta")?.delta).toBe("line1\nline2");
    expect(result.at(-1).response.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", namespace: "functions", input: "line1\nline2" });
  });

  it("marks truncated output incomplete instead of claiming completion", async () => {
    chat.mockResolvedValue(stream([chunk({ content: "Partial" }), chunk({}, "length")]));
    const result = await events(await respond({ stream: true }));
    expect(result.at(-1)).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
    expect(result.some((event) => event.type === "response.completed")).toBe(false);
  });

  it("preserves upstream HTTP errors and Retry-After", async () => {
    const upstream = Response.json({ error: { message: "Quota", type: "rate_limit_error" } }, { status: 429, headers: { "Retry-After": "30" } });
    chat.mockResolvedValue(upstream);
    const response = await respond({ stream: true });
    expect(response).toBe(upstream);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it.each([
    [chunk({}), { error: { message: "Throttled", code: "m365_throttled", type: "rate_limit_error" } }],
    [chunk({ content: "Interrupted" })],
  ])("emits failure, not success, for stream errors or premature EOF", async (...chunks) => {
    chat.mockResolvedValue(stream(chunks, false));
    const result = await events(await respond({ stream: true }));
    expect(result.at(-1).type).toBe("response.failed");
    expect(result.at(-1).response.error.message).toBeTruthy();
    expect(result.some((event) => event.type === "response.completed")).toBe(false);
  });
});

describe("Responses fetch route", () => {
  it("reports the rejected tool type so desktop-only declarations can be diagnosed", async () => {
    const response = await createApp().fetch(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ input: "Hello", tools: [{ type: "unsupported_native" }] }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("Unsupported Responses tool type: unsupported_native");
    expect(chat).not.toHaveBeenCalled();
  });

  it("serves Codex model catalogs without changing the OpenAI model-list response", async () => {
    const app = createApp();
    const standard = await (await app.fetch(new Request("http://localhost/v1/models"))).json();
    const codex = await (await app.fetch(new Request("http://localhost/v1/models?client_version=0.162.1"))).json();
    expect(standard.object).toBe("list");
    expect(standard.models).toBeUndefined();
    expect(codex.data.map((model: { id: string }) => model.id)).toEqual(standard.data.map((model: { id: string }) => model.id));
    expect(codex.models).toEqual([]);
    expect(standard.data.some((model: { id: string }) => model.id === "gpt-6.1-sol")).toBe(true);
  });

  it("serves /v1/responses with existing CORS behavior", async () => {
    const response = await createApp().fetch(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ input: "Hello" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await response.json()).object).toBe("response");
  });

  it.each([
    { input: "Hello", tools: [{ type: "web_search" }] },
    { input: [{ type: "item_reference", id: "item" }] },
    { input: [] },
    {},
  ])("rejects invalid or unsupported requests without contacting M365: %j", async (body) => {
    const response = await createApp().fetch(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });
});
