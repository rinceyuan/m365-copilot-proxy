import { createHash, randomUUID } from "node:crypto";
import { ChatCompletionRequest } from "./schemas.js";
import { handleResponsesWithCompletion, parseSseJson, ResponsesRequest } from "./responses.js";

type Json = Record<string, any>;
type Relay = (request: Request) => Promise<Response>;

function wireName(name: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(name) ? name : `tool_${createHash("sha256").update(name).digest("hex").slice(0, 40)}`;
}

function contentParts(content: unknown): Json[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) throw new Error("Expected text or a content array");
  return content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part.type === "image_url") {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(part.image_url?.url ?? "");
      if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
    }
    throw new Error("This native adapter supports text and base64 images only");
  });
}

export function toNativeMessages(input: Json): { body: Json; names: Map<string, string> } {
  const chat = ChatCompletionRequest.parse(input);
  const messages: Json[] = [], system: Json[] = [], names = new Map<string, string>();
  const push = (role: string, content: Json[]) => {
    if (!content.length) throw new Error("Empty conversational message");
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of chat.messages) {
    if (message.role === "system") {
      const parts = contentParts(message.content);
      if (parts.some((part) => part.type !== "text")) throw new Error("System instructions must be text");
      system.push(...parts);
    } else if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("tool_call_id is required");
      push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: contentParts(message.content) }]);
    } else {
      const content = [...(message.reasoning_details ?? []), ...contentParts(message.content)];
      for (const call of message.tool_calls ?? []) {
        const args = JSON.parse(call.function.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Function arguments must be a JSON object");
        content.push({ type: "tool_use", id: call.id, name: wireName(call.function.name), input: args });
      }
      push(message.role, content);
    }
  }
  const body: Json = { model: chat.model, messages, max_tokens: chat.max_completion_tokens ?? chat.max_tokens ?? 4096, stream: chat.stream };
  if (system.length) body.system = system;
  for (const name of ["temperature", "top_p"] as const) if (chat[name] !== undefined) body[name] = chat[name];
  if (chat.stop) body.stop_sequences = typeof chat.stop === "string" ? [chat.stop] : chat.stop;
  if (chat.tools?.length && chat.tool_choice !== "none") {
    body.tools = chat.tools.map(({ function: tool }) => {
      const name = wireName(tool.name);
      names.set(name, tool.name);
      return {
        type: "custom", name, description: name === tool.name ? tool.description : `${tool.name}\n${tool.description ?? ""}`,
        input_schema: tool.parameters ?? { type: "object", properties: {} },
      };
    });
    const choice = chat.tool_choice;
    body.tool_choice = typeof choice === "object" ? { type: "tool", name: wireName(choice.function.name) } :
      { type: choice === "required" ? "any" : "auto" };
    if (chat.parallel_tool_calls === false) body.tool_choice.disable_parallel_tool_use = true;
  }
  if (chat.reasoning_effort) {
    body.thinking = { type: chat.reasoning_effort === "none" ? "disabled" : "adaptive" };
    if (chat.reasoning_effort !== "none") body.output_config = { effort: chat.reasoning_effort };
  }
  return { body, names };
}

function usageFor(usage: Json = {}) {
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return {
    prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.thinking_tokens ?? 0 },
  };
}

function finishReason(reason: string): string {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

export function toNativeCompletion(data: Json, names: Map<string, string>) {
  if (data.type !== "message" || !Array.isArray(data.content)) throw new Error("Invalid native message response");
  const calls = data.content.filter((block: Json) => block.type === "tool_use").map((block: Json) => ({
    id: block.id, type: "function", function: { name: names.get(block.name) ?? block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  const reasoning = data.content.filter((block: Json) => ["thinking", "redacted_thinking"].includes(block.type));
  return {
    id: data.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: data.model,
    choices: [{
      index: 0, finish_reason: finishReason(data.stop_reason),
      message: {
        role: "assistant", content: data.content.filter((block: Json) => block.type === "text").map((block: Json) => block.text).join("") || null,
        ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning.length ? { reasoning_details: reasoning } : {}),
      },
    }],
    usage: usageFor(data.usage),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function nativeChatStream(upstream: Response, names: Map<string, string>, requestedModel: string, includeUsage: boolean): Response {
  const reader = upstream.body!.getReader();
  async function* events() {
    let id = randomUUID(), model = requestedModel, usage: Json = {}, reason = "";
    let nextTool = 0, stopped = false;
    const blocks = new Map<number, Json>();
    const frame = (data: unknown) => new TextEncoder().encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    const chunk = (delta: Json, finish_reason: string | null = null) => ({
      id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta, finish_reason }],
    });
    try {
      for await (const event of parseSseJson(reader)) {
        if (event.type === "error") throw new Error(event.error?.message ?? "Native upstream stream failed");
        if (event.type === "message_start") {
          id = event.message.id; model = event.message.model; usage = { ...event.message.usage };
          yield frame(chunk({ role: "assistant", content: "" }));
        } else if (event.type === "content_block_start") {
          const block = { ...event.content_block };
          blocks.set(event.index, block);
          if (block.type === "tool_use") {
            block.toolIndex = nextTool++; block.arguments = Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : "";
            yield frame(chunk({ tool_calls: [{ index: block.toolIndex, id: block.id, type: "function", function: { name: names.get(block.name) ?? block.name, arguments: block.arguments } }] }));
          } else if (block.type === "text" && block.text) yield frame(chunk({ content: block.text }));
        } else if (event.type === "content_block_delta") {
          const block = blocks.get(event.index), delta = event.delta;
          if (!block) throw new Error("Native delta without a content block");
          if (delta.type === "text_delta") yield frame(chunk({ content: delta.text }));
          else if (delta.type === "input_json_delta") {
            block.arguments += delta.partial_json;
            yield frame(chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] }));
          } else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
          else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
        } else if (event.type === "content_block_stop") {
          const block = blocks.get(event.index);
          if (block?.type === "thinking" || block?.type === "redacted_thinking") yield frame(chunk({ reasoning_details: [block] }));
          if (block?.type === "tool_use" && !block.arguments) yield frame(chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: "{}" } }] }));
        } else if (event.type === "message_delta") {
          usage = { ...usage, ...event.usage }; reason = event.delta?.stop_reason ?? reason;
        } else if (event.type === "message_stop") {
          if (!reason) throw new Error("Native stream ended without a stop reason");
          stopped = true;
          yield frame(chunk({}, finishReason(reason)));
          if (includeUsage) yield frame({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageFor(usage) });
          yield frame("[DONE]");
          return;
        }
      }
      if (!stopped) throw new Error("Native stream ended without message_stop");
    } catch (error: any) {
      yield frame({ error: { type: "upstream_error", message: error.message } });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const iterator = events();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await iterator.return(undefined);
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

export async function handleNativeCompatibility(req: Request, input: Json, relay: Relay): Promise<Response> {
  const complete = async (chat: Json, signal: AbortSignal) => {
    const { body, names } = toNativeMessages(chat);
    const url = new URL(req.url);
    url.pathname = "/v1/messages";
    const headers = new Headers(req.headers);
    headers.set("Content-Type", "application/json");
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    const upstream = await relay(new Request(url, { method: "POST", headers, body: JSON.stringify(body), signal }));
    if (!upstream.ok) return upstream;
    if (body.stream) {
      if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
        return jsonResponse(502, { error: { type: "upstream_error", message: "Expected a native SSE stream" } });
      }
      return nativeChatStream(upstream, names, body.model, chat.stream_options?.include_usage === true);
    }
    try {
      return jsonResponse(200, toNativeCompletion(await upstream.json(), names));
    } catch {
      return jsonResponse(502, { error: { type: "upstream_error", message: "Invalid native message response" } });
    }
  };
  try {
    return new URL(req.url).pathname === "/v1/responses"
      ? await handleResponsesWithCompletion(ResponsesRequest.parse(input), (chat, { signal }) => complete(chat, signal), { signal: req.signal })
      : await complete(input, req.signal);
  } catch (error: any) {
    return jsonResponse(400, { error: { type: "invalid_request_error", message: error.message } });
  }
}
