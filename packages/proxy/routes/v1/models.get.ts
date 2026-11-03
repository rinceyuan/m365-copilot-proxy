import { buildModelsPayload, getProxyBackend } from "@m365-copilot/proxy-lib";
import { handleLlmApiEvent } from "../../llmapi-handler";

export default defineEventHandler((event) =>
  getProxyBackend() === "llmapi"
    ? handleLlmApiEvent(event)
    : buildModelsPayload(getQuery(event).client_version !== undefined),
);
