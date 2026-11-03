import { z } from "zod/v4";
import { ChatCompletionRequest } from "./schemas.js";
import { handleChatCompletion, type SessionPool } from "./handler.js";

interface ResponseTool {
  type: "function" | "custom" | "namespace";
  name: string;
  description?: string;
  parameters?: unknown;
  format?: { type: string; syntax?: string; definition?: string };
  tools?: ResponseTool[];
}

const ResponseToolSchema: z.ZodType<ResponseTool> = z.lazy(() => z.object({
  type: z.enum(["function", "custom", "namespace"], {
    error: (issue) => `Unsupported Responses tool type: ${typeof issue.input === "string" ? issue.input.slice(0, 80) : typeof issue.input}`,
  }),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
  format: z.object({
    type: z.string(),
    syntax: z.string().optional(),
    definition: z.string().optional(),
  }).optional(),
  tools: z.array(ResponseToolSchema).optional(),
}));

const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() }),
  z.object({ type: z.literal("input_image"), image_url: z.string() }),
  z.object({ type: z.literal("refusal"), refusal: z.string() }),
]);
const Content = z.union([z.string(), z.array(ContentPart)]);
const CallIdentity = { call_id: z.string(), name: z.string(), namespace: z.string().optional() };
const InputItem = z.union([
  z.object({
    type: z.literal("message").optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: Content,
  }),
  z.object({ type: z.literal("function_call"), ...CallIdentity, arguments: z.string() }),
  z.object({ type: z.literal("custom_tool_call"), ...CallIdentity, input: z.string() }),
  z.object({
    type: z.enum(["function_call_output", "custom_tool_call_output"]),
    call_id: z.string(),
    output: Content,
  }),
  z.object({ type: z.literal("additional_tools"), tools: z.array(ResponseToolSchema) }),
  z.object({ type: z.literal("reasoning"), encrypted_content: z.string().nullish() }),
]);

export const ResponsesRequest = z.object({
  model: z.string().optional().default("gpt-5.5-think-deeper"),
  input: z.union([z.string(), z.array(InputItem)]),
  instructions: z.string().nullish(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ResponseToolSchema).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none", "required"]),
    z.object({
      type: z.enum(["function", "custom"]),
      name: z.string(),
      namespace: z.string().optional(),
    }),
  ]).optional(),
  temperature: z.number().optional(),
  max_output_tokens: z.number().optional(),
  reasoning: z.object({ effort: z.string().nullish() }).nullish(),
  parallel_tool_calls: z.boolean().optional(),
  previous_response_id: z.string().nullish(),
  background: z.boolean().optional(),
});

type ResponsesBody = z.infer<typeof ResponsesRequest>;
type ChatBody = z.infer<typeof ChatCompletionRequest>;
interface ToolIdentity { name: string; namespace?: string; custom: boolean }

const NATIVE_REASONING = "m365-anthropic-v1:";

function decodeNativeReasoning(value?: string | null): Record<string, unknown>[] {
  if (!value?.startsWith(NATIVE_REASONING)) return [];
  const blocks = JSON.parse(Buffer.from(value.slice(NATIVE_REASONING.length), "base64url").toString("utf8"));
  if (!Array.isArray(blocks) || blocks.some((block) => !block ||
      !(block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" ||
        block.type === "redacted_thinking" && typeof block.data === "string"))) {
    throw new Error("Invalid native reasoning state");
  }
  return blocks;
}

function toolName(tool: ToolIdentity): string {
  const qualified = tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
  // A custom exec tool can execute JavaScript, not shell commands. Keep it out
  // of core's shell aliases and wrap its raw input in a non-command parameter.
  return tool.custom ? `custom.${qualified}` : qualified;
}

function chatContent(content: z.infer<typeof Content>) {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "input_image"
    ? { type: "image_url", image_url: { url: part.image_url } }
    : { type: "text", text: part.type === "refusal" ? part.refusal : part.text });
}

function translateRequest(body: ResponsesBody) {
  if (body.previous_response_id) {
    throw new Error("previous_response_id is not supported; send the full input history with store:false");
  }
  if (body.background) throw new Error("Background Responses are not supported");
  const items = typeof body.input === "string"
    ? [{ type: "message" as const, role: "user" as const, content: body.input }]
    : body.input;
  const identities = new Map<string, ToolIdentity>();
  const definitions = new Map<string, NonNullable<ChatBody["tools"]>[number]>();
  function addTools(tools: ResponseTool[], namespace?: string) {
    for (const tool of tools) {
      if (tool.type === "namespace") {
        if (!tool.tools) throw new Error(`Namespace ${tool.name} is missing tools`);
        addTools(tool.tools, namespace ? `${namespace}.${tool.name}` : tool.name);
        continue;
      }
      const identity = { name: tool.name, namespace, custom: tool.type === "custom" };
      const name = toolName(identity);
      identities.set(name, identity);
      const grammar = tool.format?.definition;
      definitions.set(name, {
        type: "function",
        function: {
          name,
          description: [tool.description, grammar ? `Input grammar (${tool.format?.syntax ?? "text"}):\n${grammar}` : undefined].filter(Boolean).join("\n\n"),
          parameters: identity.custom ? {
            type: "object",
            properties: { content: { type: "string", description: "The complete raw input for this custom tool." } },
            required: ["content"],
            additionalProperties: false,
          } : tool.parameters,
        },
      });
    }
  }
  addTools(body.tools ?? []);
  for (const item of items) {
    if (item.type === "additional_tools") addTools(item.tools);
  }
  const messages: ChatBody["messages"] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of items) {
    switch (item.type) {
      case undefined:
      case "message": {
        const role = item.role === "developer" ? "system" : item.role;
        const content = chatContent(item.content);
        const previous = messages.at(-1);
        // Codex sends environment context before the actual user prompt. Keep
        // both in the opener that the chat session pool fingerprints.
        if (role === "user" && previous?.role === "user") {
          previous.content = [
            ...(typeof previous.content === "string" ? [{ type: "text", text: previous.content }] : previous.content ?? []),
            ...(typeof content === "string" ? [{ type: "text", text: content }] : content),
          ];
        } else messages.push({ role, content });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = toolName({ ...item, custom: item.type === "custom_tool_call" });
        const call = {
          id: item.call_id,
          type: "function" as const,
          function: { name, arguments: item.type === "custom_tool_call" ? JSON.stringify({ content: item.input }) : item.arguments },
        };
        const previous = messages.at(-1);
        if (previous?.role === "assistant") (previous.tool_calls ??= []).push(call);
        else messages.push({ role: "assistant", content: null, tool_calls: [call] });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({ role: "tool", tool_call_id: item.call_id, content: chatContent(item.output) });
        break;
      case "reasoning": {
        const blocks = decodeNativeReasoning(item.encrypted_content);
        if (blocks.length) {
          const previous = messages.at(-1);
          if (previous?.role === "assistant") (previous.reasoning_details ??= []).push(...blocks);
          else messages.push({ role: "assistant", content: null, reasoning_details: blocks });
        }
        break;
      }
      case "additional_tools":
        break;
    }
  }
  const choice = body.tool_choice;
  const chat = ChatCompletionRequest.parse({
    model: body.model,
    messages,
    stream: body.stream,
    stream_options: { include_usage: true },
    tools: definitions.size ? [...definitions.values()] : undefined,
    tool_choice: typeof choice === "object"
      ? { type: "function", function: { name: toolName({ ...choice, custom: choice.type === "custom" }) } }
      : choice,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
    reasoning_effort: body.reasoning?.effort ?? undefined,
    parallel_tool_calls: body.parallel_tool_calls,
  });
  return { chat, identities };
}

interface OutputItem {
  id: string;
  type: "message" | "function_call" | "custom_tool_call" | "reasoning";
  status: string;
  role?: "assistant";
  content?: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  input?: string;
  summary?: unknown[];
  encrypted_content?: string;
}

class ResponseBuilder {
  readonly response;
  private sequence = 0;
  private message?: OutputItem;
  private calls = new Map<number, { item: OutputItem; arguments: string }>();

  constructor(
    model: string,
    private identities: Map<string, ToolIdentity>,
    private emit: (event: Record<string, unknown>) => void = () => {},
  ) {
    this.response = {
      id: `resp_${crypto.randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      status: "in_progress",
      output: [] as OutputItem[],
      error: null as Record<string, unknown> | null,
      incomplete_details: null as { reason: string } | null,
      store: false,
      parallel_tool_calls: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } as Record<string, unknown>,
    };
  }

  private send(type: string, fields: Record<string, unknown>) {
    this.emit({ type, sequence_number: this.sequence++, ...fields });
  }

  progress(created = false) {
    if (created) this.send("response.created", { response: this.response });
    this.send("response.in_progress", { response: this.response });
  }

  text(delta: string) {
    if (!delta) return;
    if (!this.message) {
      this.message = { id: `msg_${crypto.randomUUID()}`, type: "message", status: "in_progress", role: "assistant", content: [] };
      this.response.output.push(this.message);
      this.send("response.output_item.added", { output_index: this.response.output.length - 1, item: this.message });
      this.message.content!.push({ type: "output_text", text: "", annotations: [] });
      this.send("response.content_part.added", { item_id: this.message.id, output_index: this.response.output.length - 1, content_index: 0, part: this.message.content![0] });
    }
    this.message.content![0].text += delta;
    this.send("response.output_text.delta", { item_id: this.message.id, output_index: this.response.output.indexOf(this.message), content_index: 0, delta });
  }

  reasoning(blocks?: Record<string, unknown>[]) {
    if (!blocks?.length) return;
    const item: OutputItem = {
      id: `rs_${crypto.randomUUID()}`, type: "reasoning", status: "in_progress", summary: [],
      encrypted_content: NATIVE_REASONING + Buffer.from(JSON.stringify(blocks)).toString("base64url"),
    };
    this.response.output.push(item);
    this.send("response.output_item.added", { output_index: this.response.output.length - 1, item });
  }

  tool(index: number, call: { id?: string; function?: { name?: string; arguments?: string } }) {
    let state = this.calls.get(index);
    if (!state) {
      const identity = this.identities.get(call.function?.name ?? "");
      if (!identity || !call.id) throw new Error(`Unknown or incomplete tool call: ${call.function?.name ?? index}`);
      const item: OutputItem = {
        id: `${identity.custom ? "ctc" : "fc"}_${crypto.randomUUID()}`,
        type: identity.custom ? "custom_tool_call" : "function_call",
        status: "in_progress",
        name: identity.name,
        ...(identity.namespace ? { namespace: identity.namespace } : {}),
        call_id: call.id,
        ...(identity.custom ? { input: "" } : { arguments: "" }),
      };
      state = { item, arguments: "" };
      this.calls.set(index, state);
      this.response.output.push(item);
      this.send("response.output_item.added", { output_index: this.response.output.length - 1, item });
    }
    const delta = call.function?.arguments ?? "";
    state.arguments += delta;
    if (state.item.type === "function_call") {
      state.item.arguments = state.arguments;
      if (delta) this.send("response.function_call_arguments.delta", { item_id: state.item.id, output_index: this.response.output.indexOf(state.item), delta });
    }
  }

  usage(usage?: Record<string, unknown>) {
    if (!usage) return;
    this.response.usage = {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: (usage.prompt_tokens_details as any)?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: (usage.completion_tokens_details as any)?.reasoning_tokens ?? 0 },
      ...Object.fromEntries(Object.entries(usage).filter(([key]) => key.startsWith("x_m365_"))),
    };
  }

  finish(reason?: string) {
    for (const { item, arguments: args } of this.calls.values()) {
      const output_index = this.response.output.indexOf(item);
      if (item.type === "custom_tool_call") {
        item.input = z.object({ content: z.string() }).parse(JSON.parse(args)).content;
        this.send("response.custom_tool_call_input.delta", { item_id: item.id, output_index, delta: item.input });
        this.send("response.custom_tool_call_input.done", { item_id: item.id, output_index, input: item.input });
      } else {
        this.send("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments });
      }
    }
    for (const [output_index, item] of this.response.output.entries()) {
      item.status = reason === "length" && item.type === "message" ? "incomplete" : "completed";
      if (item.type === "message") {
        const fields = { item_id: item.id, output_index, content_index: 0 };
        this.send("response.output_text.done", { ...fields, text: item.content![0].text });
        this.send("response.content_part.done", { ...fields, part: item.content![0] });
      }
      this.send("response.output_item.done", { output_index, item });
    }
    this.response.status = reason === "length" ? "incomplete" : "completed";
    this.response.incomplete_details = reason === "length" ? { reason: "max_output_tokens" } : null;
    this.send(`response.${this.response.status}`, { response: this.response });
  }

  fail(error: { message?: string; code?: string; type?: string }) {
    this.response.status = "failed";
    this.response.error = { ...error, code: error.code ?? error.type ?? "server_error", message: error.message ?? "Upstream stream failed" };
    this.send("response.failed", { response: this.response });
  }
}

export async function* parseSseJson(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error("Oversized upstream SSE frame");
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
    if (done) return;
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Stateless Responses compatibility; all upstream sessions and tool parsing stay in the chat handler. */
export async function handleResponses(body: ResponsesBody, pool: SessionPool, opts: { signal?: AbortSignal } = {}): Promise<Response> {
  return handleResponsesWithCompletion(body, (chat, options) => handleChatCompletion(chat, pool, options), opts);
}

export async function handleResponsesWithCompletion(
  body: ResponsesBody,
  complete: (chat: ChatBody, opts: { signal: AbortSignal }) => Promise<Response>,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  let translated: ReturnType<typeof translateRequest>;
  try {
    translated = translateRequest(body);
  } catch (error: any) {
    return jsonResponse(400, { error: { message: error.message, type: "invalid_request_error" } });
  }
  const abort = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal;
  const upstream = await complete(translated.chat, { signal });
  if (!upstream.ok) return upstream;
  if (!body.stream) {
    const builder = new ResponseBuilder(body.model, translated.identities);
    try {
      const completion = await upstream.json();
      const choice = completion.choices[0];
      builder.response.model = completion.model ?? body.model;
      builder.reasoning(choice.message.reasoning_details);
      builder.text(choice.message.content ?? "");
      choice.message.tool_calls?.forEach((call: Parameters<ResponseBuilder["tool"]>[1], index: number) => builder.tool(index, call));
      builder.usage(completion.usage);
      builder.finish(choice.finish_reason);
      return jsonResponse(200, builder.response);
    } catch (error: any) {
      return jsonResponse(502, { error: { message: error.message, type: "upstream_error" } });
    }
  }
  if (!upstream.body) return jsonResponse(502, { error: { message: "Missing upstream stream", type: "upstream_error" } });
  const reader = upstream.body.getReader();
  let cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const builder = new ResponseBuilder(body.model, translated.identities, (event) => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      });
      let finishReason: string | undefined;
      let failed = false;
      try {
        builder.progress(true);
        for await (const chunk of parseSseJson(reader)) {
          if (cancelled) return;
          if (chunk.error) {
            builder.fail(chunk.error);
            failed = true;
            break;
          }
          if (chunk.model) builder.response.model = chunk.model;
          builder.usage(chunk.usage);
          for (const choice of chunk.choices ?? []) {
            if (choice.index !== 0) continue;
            const delta = choice.delta ?? {};
            builder.reasoning(delta.reasoning_details);
            builder.text(delta.content ?? "");
            delta.tool_calls?.forEach((call: Parameters<ResponseBuilder["tool"]>[1] & { index: number }) => builder.tool(call.index, call));
            if (choice.finish_reason) finishReason = choice.finish_reason;
            else if (!delta.content && !delta.tool_calls) builder.progress();
          }
        }
        if (!failed) {
          if (!finishReason) throw new Error("Upstream stream ended without a finish reason");
          builder.finish(finishReason);
        }
      } catch (error: any) {
        if (!cancelled) builder.fail({ message: error.message, type: "upstream_error" });
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (!cancelled) controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      abort.abort(reason);
      await reader.cancel(reason).catch(() => {});
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
