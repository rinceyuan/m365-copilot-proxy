import { handleLlmApiRequest, handleSelectedLlmApiRequest } from "@m365-copilot/proxy-lib";

export const handleLlmApiEvent = defineEventHandler((event) => {
  const controller = new AbortController();
  const req = event.node.req;
  const res = event.node.res;
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  res.once("finish", () => {
    req.off("aborted", abort);
    res.off("close", abort);
  });
  const request = new Request(toWebRequest(event), { signal: controller.signal });
  return new URL(request.url).pathname.startsWith("/v1/")
    ? handleSelectedLlmApiRequest(request)
    : handleLlmApiRequest(request);
});
