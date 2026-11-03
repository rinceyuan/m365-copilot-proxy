import { getToken } from "@m365-copilot/core";
import { getProxyBackend, getLlmApiAuthMode } from "@m365-copilot/proxy-lib";

/**
 * Sydney authenticates once at startup and aborts boot on failure.
 * LLMAPI credentials are independent and supplied on each request.
 */
export default defineNitroPlugin(async () => {
  if (getProxyBackend() === "llmapi") {
    console.log(`LLMAPI selected (${getLlmApiAuthMode()} authorization); Sydney authentication is disabled.`);
    return;
  }
  console.log("Authenticating...");
  try {
    await getToken();
  } catch (err: any) {
    console.error(`Auth failed: ${err.message}`);
    throw err;
  }
});
