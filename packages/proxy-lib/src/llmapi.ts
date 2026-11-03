import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createLogger, fileLoggingEnabled } from "@m365-copilot/core";
import { AppManagedAuthError, loadAppManagedProvider } from "./llmapi-app-managed.js";
import { handleNativeCompatibility } from "./llmapi-compat.js";

const UPSTREAM = "https://loki.delve.office.com/api/v1/llmapi";
const API_VERSION = "2026-09-22";
const MIB = 1024 * 1024;
const ROUTES = new Map([
  ["/llmapi/v1/models", { method: "GET", path: "/models", limit: 0 }],
  ["/llmapi/v1/chat/completions", { method: "POST", path: "/chat/completions", limit: 5 * MIB }],
  ["/llmapi/v1/responses", { method: "POST", path: "/responses", limit: 5 * MIB }],
  ["/llmapi/v1/messages", { method: "POST", path: "/v1/messages", limit: 12 * MIB }],
]);
const CALLER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CLIENT_METADATA = [
  ["X-ClientScenario", "M365_LLMAPI_CLIENT_SCENARIO", "Code"],
  ["X-ClientType", "M365_LLMAPI_CLIENT_TYPE", "Copilot"],
  ["X-ClientFeature", "M365_LLMAPI_CLIENT_FEATURE", "LlmApiProxy"],
] as const;
const RESPONSE_HEADERS = [
  "content-type", "retry-after", "x-cv", "x-conversationid",
  "x-clientcallid", "x-llm-api-version", "request-id",
];

// Clients without a context-size picker (VS Code BYOK) can list one model several times as
// "<model>@200k" etc. to offer different client-side context budgets. Only the suffix is
// removed before forwarding; the context limit itself is enforced by the client.
const CONTEXT_VARIANT = /^([A-Za-z0-9._:-]+)@\d{1,7}[km]$/i;

export function upstreamModelId(model: string): string {
  return CONTEXT_VARIANT.exec(model)?.[1] ?? model;
}

export interface LlmApiOptions {
  token?: string;
  clientMetadata?: Record<string, string>;
}

export function getLlmApiAuthMode(): "explicit" | "app-managed" {
  const mode = process.env.M365_LLMAPI_AUTH ?? "explicit";
  if (mode === "explicit" || mode === "app-managed") return mode;
  throw new Error("M365_LLMAPI_AUTH must be explicit or app-managed.");
}

export function getProxyBackend(): "sydney" | "llmapi" {
  const backend = process.env.M365_BACKEND ?? "sydney";
  if (backend === "sydney" || backend === "llmapi") return backend;
  throw new Error("M365_BACKEND must be sydney or llmapi.");
}

function error(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleSelectedLlmApiRequest(req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  if (!pathname.startsWith("/v1/") || !ROUTES.has(`/llmapi${pathname}`)) {
    return error(404, "not_found", "Unknown LLMAPI route.");
  }
  if (getLlmApiAuthMode() === "explicit") {
    return handleLlmApiRequest(req, { token: process.env.M365_LLMAPI_TOKEN || undefined });
  }
  const hostname = new URL(req.url).hostname;
  const host = req.headers.get("host");
  if (req.headers.has("origin") || !["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
      (host !== null && host !== new URL(req.url).host)) {
    return error(403, "llmapi_local_only", "App-managed LLMAPI is restricted to local non-browser clients.");
  }
  try {
    const key = process.env.M365_LLMAPI_LOCAL_API_KEY ??
      (process.env.M365_LLMAPI_API_KEY_FILE ? (await readFile(process.env.M365_LLMAPI_API_KEY_FILE, "utf8")).trim() : "");
    if (!/^[\x21-\x7e]{32,512}$/.test(key)) {
      return error(503, "llmapi_local_key_required", "Configure a private local LLMAPI client key of at least 32 characters.");
    }
    const supplied = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
    const expectedBytes = Buffer.from(key);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      return error(401, "llmapi_local_auth_required", "Supply the local proxy client key.");
    }
    const provider = await loadAppManagedProvider();
    try {
      if (req.method === "POST" && ["/v1/chat/completions", "/v1/responses"].includes(pathname)) {
        if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          return error(415, "unsupported_media_type", "LLMAPI inference requires application/json.");
        }
        const bytes = await readLimitedBody(req, 5 * MIB);
        if (!bytes) return error(413, "body_too_large", "Request exceeds the LLMAPI route body limit.");
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        } catch {
          return error(400, "invalid_body", "Request body must be a JSON object.");
        }
        if (typeof body.model === "string" && body.model.startsWith("claude-")) {
          return await handleNativeCompatibility(req, body, (native) =>
            handleLlmApiRequest(native, { token: provider.getToken(), clientMetadata: provider.headers }));
        }
        req = new Request(req.url, { method: req.method, headers: req.headers, body: bytes, signal: req.signal });
      }
      return await handleLlmApiRequest(req, { token: provider.getToken(), clientMetadata: provider.headers });
    } finally {
      provider.dispose();
    }
  } catch (err) {
    return err instanceof AppManagedAuthError
      ? error(503, err.code, err.message)
      : error(503, "m365_authorization_unavailable", "M365 app-managed authorization is unavailable; initialize its Code session.");
  }
}

async function readLimitedBody(req: Request, limit: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function observeNativeResponse(upstream: Response, requestId: string): ReadableStream<Uint8Array> | null {
  const log = createLogger("llmapi");
  const upstreamId = upstream.headers.get("request-id");
  const context = {
    request_id: requestId,
    status: upstream.status,
    ...(upstreamId && CALLER_ID.test(upstreamId) ? { upstream_request_id: upstreamId } : {}),
  };
  log.info("native_response", context);
  if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream.body;

  const decoder = new TextDecoder();
  const limit = 64 * 1024;
  const summary: Record<string, unknown> = { message_stop: false };
  let line = "", data = "", dropLine = false, dropEvent = false;
  const token = (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
  const event = () => {
    try {
      if (!data || dropEvent) return;
      const value = JSON.parse(data);
      if (value.type === "message_stop") summary.message_stop = true;
      if (value.type === "message_start" || value.type === "message_delta") {
        const usage = value.message?.usage ?? value.usage;
        for (const name of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
          if (Number.isSafeInteger(usage?.[name]) && usage[name] >= 0) summary[name] = usage[name];
        }
      }
      if (value.type === "message_delta" && token(value.delta?.stop_reason)) {
        summary.stop_reason = token(value.delta.stop_reason);
        const details = value.delta.stop_details ?? value.stop_details;
        summary.stop_details_present = details != null;
        if (token(details?.category)) summary.refusal_category = token(details.category);
        summary.has_refusal_explanation = typeof details?.explanation === "string";
        log.info("native_stop", { ...context, ...summary });
      } else if (value.type === "error") {
        log.info("native_stream_error", { ...context, error_type: token(value.error?.type) });
      }
    } catch {
      summary.diagnostic_parse_error = true;
    } finally {
      data = "";
      dropEvent = false;
    }
  };
  const consumeLine = (value: string) => {
    value = value.replace(/\r$/, "");
    if (!value) {
      event();
    } else if (value.startsWith("data:") && !dropEvent) {
      const part = value.slice(5).replace(/^ /, "");
      if (data.length + part.length + 1 <= limit) data += (data ? "\n" : "") + part;
      else {
        data = "";
        dropEvent = true;
        summary.diagnostic_truncated = true;
      }
    }
  };
  return upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      while (start < text.length) {
        const end = text.indexOf("\n", start);
        const part = text.slice(start, end < 0 ? text.length : end);
        if (!dropLine) {
          if (line.length + part.length <= limit) line += part;
          else {
            line = data = "";
            dropLine = dropEvent = true;
            summary.diagnostic_truncated = true;
          }
        }
        if (end < 0) break;
        if (!dropLine) consumeLine(line);
        line = "";
        dropLine = false;
        start = end + 1;
      }
      controller.enqueue(chunk);
    },
    flush() {
      log.info("native_stream_end", { ...context, ...summary, unterminated_event: !!line || !!data || dropEvent });
    },
  }));
}

/** Native relay with independent credentials; never uses Sydney auth or fallback. */
export async function handleLlmApiRequest(req: Request, options: LlmApiOptions = {}): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const route = ROUTES.get(pathname.startsWith("/v1/") ? `/llmapi${pathname}` : pathname);
  if (!route) return error(404, "not_found", "Unknown LLMAPI route.");
  if (req.method !== route.method) {
    const response = error(405, "method_not_allowed", `Use ${route.method} for this route.`);
    response.headers.set("Allow", route.method);
    return response;
  }

  const authorization = options.token === undefined
    ? req.headers.get("authorization")
    : `Bearer ${options.token}`;
  if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(authorization)) {
    return error(401, "llmapi_auth_required", "Supply a bearer token authorized for LLMAPI.");
  }
  const conversationId = req.headers.get("x-conversationid") ?? randomUUID();
  if (!CALLER_ID.test(conversationId)) {
    return error(400, "invalid_conversation_id", "X-ConversationId must be 1-128 ASCII letters, digits, or -_.:.");
  }
  const callId = req.headers.get("x-clientcallid");
  const requestId = randomUUID();
  const headers = new Headers({
    Authorization: authorization,
    "X-Llm-Api-Version": options.clientMetadata?.["X-Llm-Api-Version"] ?? req.headers.get("x-llm-api-version") ?? API_VERSION,
    "X-ConversationId": conversationId,
    "X-ClientCallId": callId && CALLER_ID.test(callId) ? callId : requestId,
  });
  for (const [name, env, fallback] of CLIENT_METADATA) {
    const value = options.clientMetadata?.[name] ?? process.env[env] ?? req.headers.get(name) ?? fallback;
    if (!/^[\x20-\x7e]{1,128}$/.test(value) || !value.trim()) {
      return error(400, "invalid_client_metadata", `${name} must be 1-128 printable ASCII characters.`);
    }
    headers.set(name, value);
  }
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    let body: Uint8Array | undefined;
    if (route.method === "POST") {
      const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return error(415, "unsupported_media_type", "LLMAPI inference requires application/json.");
      }
      const bytes = await readLimitedBody(req, route.limit);
      if (!bytes) return error(413, "body_too_large", "Request exceeds the LLMAPI route body limit.");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      } catch {
        return error(400, "invalid_body", "Request body must be a JSON object.");
      }
      const model = typeof parsed.model === "string" ? upstreamModelId(parsed.model) : undefined;
      body = model !== undefined && model !== parsed.model
        ? new TextEncoder().encode(JSON.stringify({ ...parsed, model }))
        : bytes;
      headers.set("Content-Type", "application/json");
    }

    // Workflow, entitlement and moderation headers belong to the authenticated
    // upstream. Do not copy arbitrary caller headers or follow token-bearing redirects.
    const upstream = await fetch(UPSTREAM + route.path, {
      method: route.method,
      headers,
      body,
      signal: req.signal,
      redirect: "error",
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const diagnostics = route.path === "/v1/messages" && fileLoggingEnabled();
    if (diagnostics) responseHeaders.set("X-M365-Proxy-Request-Id", requestId);
    return new Response(diagnostics ? observeNativeResponse(upstream, requestId) : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return req.signal.aborted
      ? error(499, "request_cancelled", "The client cancelled the LLMAPI request.")
      : error(502, "llmapi_upstream_error", "The LLMAPI connection failed.");
  }
}
