import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLlmApiRequest } from "./llmapi.js";
import { createApp } from "./index.js";
import { AppManagedAuthError, loadAppManagedProvider } from "./llmapi-app-managed.js";
import * as core from "@m365-copilot/core";

vi.mock("./llmapi-app-managed.js", async (original) => {
  const module = await original<typeof import("./llmapi-app-managed.js")>();
  return { ...module, loadAppManagedProvider: vi.fn() };
});

beforeEach(() => {
  for (const name of [
    "M365_BACKEND", "M365_LLMAPI_TOKEN", "M365_LLMAPI_CLIENT_SCENARIO",
    "M365_LLMAPI_CLIENT_TYPE", "M365_LLMAPI_CLIENT_FEATURE", "M365_LLMAPI_AUTH",
    "M365_LLMAPI_LOCAL_API_KEY", "M365_LLMAPI_API_KEY_FILE", "M365_LLMAPI_PROFILE",
  ]) vi.stubEnv(name, undefined);
  vi.mocked(loadAppManagedProvider).mockReset();
});

describe("selected app-managed authorization", () => {
  const localKey = "local-key-fixture-".padEnd(64, "x");
  function app() {
    vi.stubEnv("M365_BACKEND", "llmapi");
    vi.stubEnv("M365_LLMAPI_AUTH", "app-managed");
    vi.stubEnv("M365_LLMAPI_LOCAL_API_KEY", localKey);
    return createApp();
  }

  it("requires a local client key before accessing M365 authorization", async () => {
    const res = await app().fetch(request("/models", {}, "/v1"));
    expect(res.status).toBe(401);
    expect(loadAppManagedProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["http://localhost/v1/models", { Origin: "https://example.invalid" }],
    ["http://example.invalid/v1/models", {}],
    ["http://localhost/v1/models", { Host: "example.invalid" }],
  ])("rejects browser or unexpected-host access", async (url, extraHeaders) => {
    const res = await app().fetch(new Request(url, { headers: { "x-api-key": localKey, ...extraHeaders } }));
    expect(res.status).toBe(403);
    expect(loadAppManagedProvider).not.toHaveBeenCalled();
  });

  it("replaces only the selected route's local key with app-managed authorization", async () => {
    const dispose = vi.fn();
    vi.mocked(loadAppManagedProvider).mockResolvedValue({
      headers: { "X-ClientScenario": "Code", "X-ClientType": "Copilot", "X-ClientFeature": "LlmApiProxy", "X-Llm-Api-Version": "2026-09-22" },
      getToken: () => "upstream-credential-fixture",
      dispose,
    });
    const fetch = vi.fn().mockResolvedValue(new Response('{"native":true}'));
    vi.stubGlobal("fetch", fetch);
    const res = await app().fetch(request("/messages", {
      method: "POST",
      headers: { "x-api-key": localKey, "X-ClientScenario": "caller-cannot-replace-provider" },
      body: '{"model":"claude-opus-5.5","thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}',
    }, "/v1"));
    expect(res.status).toBe(200);
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBe("Bearer upstream-credential-fixture");
    expect(fetch.mock.calls[0][1].headers.get("x-clientscenario")).toBe("Code");
    expect(fetch.mock.calls[0][1].headers.has("x-api-key")).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps the independent relay caller-owned even in app-managed mode", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const res = await app().fetch(request("/models"));
    expect(res.status).toBe(200);
    expect(loadAppManagedProvider).not.toHaveBeenCalled();
  });

  it("returns an actionable expired-session error without attempting inference", async () => {
    vi.mocked(loadAppManagedProvider).mockRejectedValue(new AppManagedAuthError("m365_authorization_expired", "Refresh the M365 Code session."));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await app().fetch(request("/models", { headers: { "x-api-key": localKey } }, "/v1"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("m365_authorization_expired");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails startup for an unknown native authentication mode", () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    vi.stubEnv("M365_LLMAPI_AUTH", "unknown");
    expect(() => createApp()).toThrow("M365_LLMAPI_AUTH must be explicit or app-managed.");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(path = "/models", init: RequestInit = {}, prefix = "/llmapi/v1"): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("Authorization", "Bearer test-authorized-token");
  if (init.body && !headers.has("content-type")) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${prefix}${path}`, { ...init, headers });
}

describe("independent LLMAPI relay", () => {
  it("uses the fixed models endpoint and does not forward trusted or unrelated headers", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(request("/models", {
      headers: {
        "X-ConversationId": "conversation:one",
        "X-ClientCallId": "call-one",
        "X-ClientScenario": "Code",
        "X-ScenarioGUID": "caller-cannot-set-this",
        "X-ModelType": "caller-cannot-set-this",
        "X-M365-Fallback-Model": "gpt-6-think-deeper",
        Cookie: "private-cookie",
      },
    }));
    expect(await res.json()).toEqual({ data: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://loki.delve.office.com/api/v1/llmapi/models");
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(options.headers.get("authorization")).toBe("Bearer test-authorized-token");
    expect(options.headers.get("x-llm-api-version")).toBe("2026-09-22");
    expect(options.headers.get("x-conversationid")).toBe("conversation:one");
    expect(options.headers.get("x-clientcallid")).toBe("call-one");
    expect(options.headers.get("x-clientscenario")).toBe("Code");
    expect(options.headers.get("x-clienttype")).toBe("Copilot");
    expect(options.headers.get("x-clientfeature")).toBe("LlmApiProxy");
    for (const name of ["x-scenarioguid", "x-modeltype", "x-m365-fallback-model", "cookie"]) {
      expect(options.headers.has(name)).toBe(false);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["/chat/completions", "/chat/completions"],
    ["/responses", "/responses"],
    ["/messages", "/v1/messages"],
  ])("relays %s without rewriting native tools or model IDs", async (local, upstream) => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetch);
    const body = JSON.stringify({ model: "exact-discovered-id", tools: [{ type: "custom" }], custom: true });
    await handleLlmApiRequest(request(local, {
      method: "POST",
      body,
      headers: { "Anthropic-Version": "2023-06-01" },
    }));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`https://loki.delve.office.com/api/v1/llmapi${upstream}`);
    expect(new TextDecoder().decode(options.body)).toBe(body);
    expect(options.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(options.headers.get("x-conversationid")).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("requires explicit bearer auth and never obtains a Sydney token", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(new Request("http://localhost/llmapi/v1/models"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("llmapi_auth_required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["/models", { method: "POST", body: "{}" }, 405],
    ["/not-a-route", {}, 404],
    ["/models", { headers: { "X-ConversationId": "invalid id" } }, 400],
    ["/messages", { method: "POST", body: "[1]" }, 400],
    ["/messages", { method: "POST", body: "not json" }, 400],
    ["/messages", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } }, 415],
  ] as const)("rejects an invalid %s request before dispatch", async (path, init, status) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(request(path, init));
    expect(res.status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the actual byte limit even without Content-Length", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(5 * 1024 * 1024) }),
    }));
    expect(res.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows Messages bodies larger than the Chat Completions limit", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(request("/messages", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(6 * 1024 * 1024) }),
    }));
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 403, 422, 429, 503])("preserves upstream %i without retries or fallbacks", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"code":"upstream-denial"}}', {
      status,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
        "X-CV": "correlation-id",
        "Set-Cookie": "do-not-relay",
      },
    }));
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(request());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code: "upstream-denial" } });
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("x-cv")).toBe("correlation-id");
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("streams native events immediately without appending a fake completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const res = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    const reader = res.body!.getReader();
    controller.enqueue(new TextEncoder().encode("event: message_start\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: message_start\n\n");
    controller.error(new Error("upstream stream interrupted"));
    await expect(reader.read()).rejects.toThrow("upstream stream interrupted");
  });

  it("propagates cancellation and does not expose connection errors or tokens", async () => {
    const controller = new AbortController();
    const req = request("/models", { signal: controller.signal });
    const fetch = vi.fn().mockImplementation((_url, options) => {
      expect(options.signal.aborted).toBe(true);
      throw new Error("private token or upstream diagnostic");
    });
    vi.stubGlobal("fetch", fetch);
    controller.abort();
    const res = await handleLlmApiRequest(req);
    expect(res.status).toBe(499);
    expect(await res.text()).not.toContain("private token");
  });

  it("sanitizes transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private diagnostic")));
    const res = await handleLlmApiRequest(request());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("private diagnostic");
  });

  it("supports configurable client metadata without forwarding trusted routing overrides", async () => {
    vi.stubEnv("M365_LLMAPI_CLIENT_SCENARIO", "CodeReview");
    vi.stubEnv("M365_LLMAPI_CLIENT_TYPE", "ProxyIntegration");
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await handleLlmApiRequest(request("/models", {
      headers: {
        "X-ClientScenario": "caller-scenario",
        "X-ClientFeature": "CallerFeature",
        "X-ScenarioGUID": "not-a-workflow-override",
      },
    }));
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers.get("x-clientscenario")).toBe("CodeReview");
    expect(headers.get("x-clienttype")).toBe("ProxyIntegration");
    expect(headers.get("x-clientfeature")).toBe("CallerFeature");
    expect(headers.has("x-scenarioguid")).toBe(false);
  });

  it.each(["invalid\nprivate-value", "x".repeat(129)])("rejects unsafe client metadata locally", async (value) => {
    vi.stubEnv("M365_LLMAPI_CLIENT_FEATURE", value);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await handleLlmApiRequest(request());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_client_metadata");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("native refusal diagnostics", () => {
  function diagnostics() {
    const log = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    vi.spyOn(core, "fileLoggingEnabled").mockReturnValue(true);
    vi.spyOn(core, "createLogger").mockReturnValue(log);
    return log;
  }

  it("records structured refusal metadata without logging response text or changing bytes", async () => {
    const log = diagnostics();
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":155700}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"private response and signature"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"diagnostic_fixture","explanation":"private explanation"}},"usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Request-Id": "upstream-request" },
    })));
    const res = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    expect(await res.text()).toBe(stream);
    expect(log.info).toHaveBeenCalledWith("native_stop", expect.objectContaining({
      stop_reason: "refusal", refusal_category: "diagnostic_fixture", output_tokens: 6,
      input_tokens: 4, cache_read_input_tokens: 155700,
      upstream_request_id: "upstream-request", has_refusal_explanation: true,
    }));
    expect(log.info).toHaveBeenCalledWith("native_stream_end", expect.objectContaining({ message_stop: true }));
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("private");
    expect(res.headers.get("x-m365-proxy-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("handles CRLF and split UTF-8 while keeping oversized content out of the diagnostic buffer", async () => {
    const log = diagnostics();
    const stream = `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x".repeat(100000) } })}\r\n\r\n` +
      'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"diagnostic_fixture","explanation":"\u4e2d\u6587"}}}\r\n\r\n' +
      'data: {"type":"message_stop"}\r\n\r\n';
    const bytes = new TextEncoder().encode(stream);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        const split = bytes.indexOf(0xe4) + 1;
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } })));
    const res = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(log.info).toHaveBeenCalledWith("native_stop", expect.objectContaining({ refusal_category: "diagnostic_fixture" }));
    expect(log.info).toHaveBeenCalledWith("native_stream_end", expect.objectContaining({ diagnostic_truncated: true, message_stop: true }));
    expect(JSON.stringify(log.info.mock.calls).length).toBeLessThan(2000);
  });

  it("does not turn a truncated or malformed stream into a refusal or a successful terminal", async () => {
    const log = diagnostics();
    const stream = 'data: malformed-json\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "Content-Type": "text/event-stream" } })));
    const res = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    expect(await res.text()).toBe(stream);
    expect(log.info).toHaveBeenCalledWith("native_stream_end", expect.objectContaining({
      message_stop: false, stop_reason: "end_turn", diagnostic_parse_error: true,
    }));
    expect(log.info).not.toHaveBeenCalledWith("native_stop", expect.objectContaining({ stop_reason: "refusal" }));
  });

  it("propagates stream errors and consumer cancellation with diagnostics enabled", async () => {
    diagnostics();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(new ReadableStream({
      start(value) { controller = value; }, cancel,
    }), { headers: { "Content-Type": "text/event-stream" } })));
    const failed = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    const reader = failed.body!.getReader();
    controller.error(new Error("upstream disconnected"));
    await expect(reader.read()).rejects.toThrow("upstream disconnected");
    const cancelled = await handleLlmApiRequest(request("/messages", { method: "POST", body: "{}" }));
    await cancelled.body!.cancel("client closed");
    expect(cancel).toHaveBeenCalledWith("client closed");
  });
});

describe("opt-in native backend", () => {
  it("keeps the existing catalog and Messages routing until explicitly selected", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const app = createApp();
    const models = await app.fetch(new Request("http://localhost/v1/models"));
    expect((await models.json()).data.some((model: { id: string }) => model.id === "claude-opus-4.8")).toBe(true);
    const messages = await app.fetch(request("/messages", { method: "POST", body: "{}" }, "/v1"));
    expect(messages.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown backend instead of silently choosing Sydney", () => {
    vi.stubEnv("M365_BACKEND", "unknown-backend");
    expect(() => createApp()).toThrow("M365_BACKEND must be sydney or llmapi.");
  });

  it("returns discovered capabilities verbatim instead of manufacturing model IDs or effort levels", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    const catalog = {
      data: [{
        id: "discovered-model",
        capabilities: {
          effort: { low: { supported: true }, max: { supported: false } },
          thinking: { supported: true, types: { adaptive: { supported: true } } },
        },
      }],
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)));
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(request("/models", {}, "/v1"));
    expect(await res.json()).toEqual(catalog);
    expect(fetch.mock.calls[0][0]).toBe("https://loki.delve.office.com/api/v1/llmapi/models");
  });

  it.each(["/chat/completions", "/responses", "/messages"])("routes native %s before the legacy schemas", async (path) => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    const body = JSON.stringify({ model: "discovered-model", tools: [{ type: "native-tool" }], custom: true });
    const fetch = vi.fn().mockResolvedValue(new Response('{"native":true}'));
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(request(path, { method: "POST", body }, "/v1"));
    expect(await res.json()).toEqual({ native: true });
    expect(fetch.mock.calls[0][0]).toBe(`https://loki.delve.office.com/api/v1/llmapi${path === "/messages" ? "/v1/messages" : path}`);
    expect(new TextDecoder().decode(fetch.mock.calls[0][1].body)).toBe(body);
  });

  it("preserves Anthropic thinking, effort, tools, results and native stream terminals", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    const body = JSON.stringify({
      model: "claude-opus-5.5",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      tools: [{ name: "read_fixture", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Previous reasoning", signature: "opaque-signature" },
            { type: "tool_use", id: "call-one", name: "read_fixture", input: { path: "fixture.txt" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-one", content: "fixture value" }] },
      ],
      stream: true,
    });
    const stream = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const fetch = vi.fn().mockResolvedValue(new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Request-Id": "native-request" },
    }));
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(request("/messages", {
      method: "POST",
      body,
      headers: { "Anthropic-Version": "2023-06-01", "Anthropic-Beta": "test-beta" },
    }, "/v1"));
    expect(new TextDecoder().decode(fetch.mock.calls[0][1].body)).toBe(body);
    expect(fetch.mock.calls[0][1].headers.get("anthropic-beta")).toBe("test-beta");
    expect(res.headers.get("request-id")).toBe("native-request");
    expect(await res.text()).toBe(stream);
  });

  it("forwards a client context-variant alias as the real model and keeps the rest of the body", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    const fetch = vi.fn().mockImplementation(async () => new Response('{"native":true}'));
    vi.stubGlobal("fetch", fetch);
    const app = createApp();
    const native = { thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] };
    for (const [requested, forwarded] of [
      ["claude-opus-5.5@200k", "claude-opus-5.5"],
      ["claude-opus-5.5@1M", "claude-opus-5.5"],
      ["gpt-61-sol@400k", "gpt-61-sol"],
      ["claude-opus-5.5@latest", "claude-opus-5.5@latest"],
    ]) {
      fetch.mockClear();
      await app.fetch(request("/messages", { method: "POST", body: JSON.stringify({ model: requested, ...native }) }, "/v1"));
      expect(JSON.parse(new TextDecoder().decode(fetch.mock.calls[0][1].body))).toEqual({ model: forwarded, ...native });
    }
  });

  it("uses an explicitly configured server token only for the selected standard backend", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    vi.stubEnv("M365_LLMAPI_TOKEN", "server-authorized");
    const fetch = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetch);
    const app = createApp();
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    expect(fetch.mock.calls[0][1].headers.get("authorization")).toBe("Bearer server-authorized");
    const relay = await app.fetch(new Request("http://localhost/llmapi/v1/models"));
    expect(relay.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still requires a caller bearer when no server credential is configured", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("llmapi_auth_required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves native quota errors even when a legacy fallback was requested", async () => {
    vi.stubEnv("M365_BACKEND", "llmapi");
    vi.stubEnv("M365_OPUS_FALLBACK_MODEL", "claude-sonnet-4.6");
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"code":"rate_limited"}}', {
      status: 429,
      headers: { "Retry-After": "30" },
    }));
    vi.stubGlobal("fetch", fetch);
    const res = await createApp().fetch(request("/messages", {
      method: "POST",
      body: '{"model":"claude-opus-5.5"}',
      headers: { "X-M365-Fallback-Model": "gpt-6-think-deeper" },
    }, "/v1"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.has("x-m365-fallback-model")).toBe(false);
  });
});
