import { ResponsesRequest, getProxyBackend, handleResponses } from "@m365-copilot/proxy-lib";
import { handleLlmApiEvent } from "../../llmapi-handler";
import { pool } from "../../server-pool";

export default defineEventHandler(async (event) => {
  if (getProxyBackend() === "llmapi") return handleLlmApiEvent(event);

  let body: ReturnType<typeof ResponsesRequest.parse>;
  try {
    body = ResponsesRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }
  return handleResponses(body, pool, { signal: ac.signal });
});
