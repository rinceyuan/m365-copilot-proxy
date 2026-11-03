#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

try {
  const file = process.env.M365_LLMAPI_API_KEY_FILE ??
    path.join(process.env.LOCALAPPDATA ?? "", "m365-copilot-proxy", ".state", "llmapi", "client-key");
  const key = (await readFile(file, "utf8")).trim();
  if (!/^[\x21-\x7e]{32,512}$/.test(key)) throw new Error();
  process.stdout.write(key);
} catch {
  process.stderr.write("The local native proxy client key is unavailable.\n");
  process.exitCode = 1;
}
