import { getProxyBackend } from "@m365-copilot/proxy-lib";
import { handleLlmApiEvent } from "../../llmapi-handler";

export default defineEventHandler((event) => {
  if (getProxyBackend() !== "llmapi") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return handleLlmApiEvent(event);
});
