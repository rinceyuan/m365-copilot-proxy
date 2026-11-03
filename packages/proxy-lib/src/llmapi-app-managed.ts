import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

const PROVIDER = "undocked-anthropic";
const UPSTREAM = "https://loki.delve.office.com/api/v1/llmapi";
const METADATA = ["X-ClientScenario", "X-ClientType", "X-ClientFeature", "X-Llm-Api-Version"];

export class AppManagedAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface AppManagedProvider {
  headers: Record<string, string>;
  getToken(): string;
  dispose(): void;
}

export function selectAppManagedProfile(profiles: string[], selected?: string): string {
  if (selected !== undefined) {
    if (!selected || selected === "." || selected === ".." || /[\\/]/.test(selected) || !profiles.includes(selected)) {
      throw new AppManagedAuthError("m365_profile_unavailable", "The configured M365 Code profile is unavailable.");
    }
    return selected;
  }
  if (profiles.length !== 1) {
    throw new AppManagedAuthError("m365_profile_ambiguous", "Select one initialized M365 Code profile with M365_LLMAPI_PROFILE.");
  }
  return profiles[0];
}

let native: {
  unprotect: (...args: any[]) => boolean;
  free: (memory: any) => unknown;
  view: (memory: any, length: number) => ArrayBuffer;
} | undefined;

async function recoverAuthorization(protectedValue: string): Promise<string> {
  if (!protectedValue.startsWith("v1.dpapi.")) {
    throw new AppManagedAuthError("m365_authorization_format", "The M365 protected authorization format is unsupported.");
  }
  const encrypted = Buffer.from(protectedValue.slice("v1.dpapi.".length), "base64");
  if (!encrypted.length) {
    throw new AppManagedAuthError("m365_authorization_format", "The M365 protected authorization is empty.");
  }
  const binding = createHash("sha256").update("Undocked.ModelProviderAuthorization.v1\0").update(PROVIDER).digest("hex");
  const entropy = createHash("sha256").update("dpapi-entropy\0").update(binding).digest();
  try {
    if (!native) {
      const koffi = (await import("koffi")).default;
      if (!native) {
        koffi.struct("M365_AppManagedBlob", { cbData: "uint32", pbData: "void *" });
        native = {
          unprotect: koffi.load("crypt32.dll").func("bool __stdcall CryptUnprotectData(M365_AppManagedBlob *in, void *description, M365_AppManagedBlob *entropy, void *reserved, void *prompt, uint32 flags, _Out_ M365_AppManagedBlob *out)"),
          free: koffi.load("kernel32.dll").func("void * __stdcall LocalFree(void *memory)"),
          view: koffi.view,
        };
      }
    }
    const output: { cbData?: number; pbData?: unknown } = {};
    if (!native.unprotect({ cbData: encrypted.length, pbData: encrypted }, null, { cbData: entropy.length, pbData: entropy }, null, null, 1, output)) {
      throw new AppManagedAuthError("m365_authorization_unavailable", "Windows could not read this user's M365 authorization.");
    }
    try {
      const plaintext = Buffer.from(native.view(output.pbData, output.cbData!));
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } finally {
      native.free(output.pbData);
    }
  } finally {
    encrypted.fill(0);
    entropy.fill(0);
  }
}

export async function decodeAppManagedProvider(
  settings: Record<string, unknown>,
  recover: (value: string) => Promise<string> = recoverAuthorization,
  now = Date.now(),
): Promise<AppManagedProvider> {
  const baseUrl = new URL(String(settings.baseUrl));
  if (baseUrl.href.replace(/\/$/, "") !== UPSTREAM) {
    throw new AppManagedAuthError("m365_gateway_invalid", "The M365 provider does not use the expected Loki endpoint.");
  }
  let rawHeaders: unknown = settings.headersJson;
  if (typeof rawHeaders === "string") rawHeaders = JSON.parse(rawHeaders);
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    throw new AppManagedAuthError("m365_provider_invalid", "The M365 provider metadata is unavailable.");
  }
  const headers: Record<string, string> = {};
  for (const name of METADATA) {
    const entry = Object.entries(rawHeaders).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!entry || typeof entry[1] !== "string" || !/^[\x20-\x7e]{1,128}$/.test(entry[1]) || !entry[1].trim()) {
      throw new AppManagedAuthError("m365_provider_invalid", "The M365 provider metadata is invalid.");
    }
    headers[name] = entry[1];
  }
  if (typeof settings.authorizationProtected !== "string") {
    throw new AppManagedAuthError("m365_authorization_unavailable", "Initialize a Claude Code session in the M365 Copilot app.");
  }
  let authorization = await recover(settings.authorizationProtected);
  if (authorization.startsWith('"')) authorization = JSON.parse(authorization);
  if (typeof authorization !== "string") {
    throw new AppManagedAuthError("m365_authorization_format", "The M365 authorization payload is unsupported.");
  }
  let token = authorization.replace(/^Bearer /, "");
  authorization = "";
  if (!/^[A-Za-z0-9._~+\/=-]+$/.test(token) || token.split(".").length !== 3) {
    token = "";
    throw new AppManagedAuthError("m365_authorization_format", "The M365 authorization payload is unsupported.");
  }
  let expiresAt: unknown;
  try {
    expiresAt = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
  } catch {
    token = "";
    throw new AppManagedAuthError("m365_authorization_format", "The M365 authorization payload is unsupported.");
  }
  if (typeof expiresAt === "number" && expiresAt * 1000 <= now) {
    token = "";
    throw new AppManagedAuthError("m365_authorization_expired", "Open the M365 Copilot app's Code session to refresh its sign-in.");
  }
  return {
    headers,
    getToken: () => token,
    dispose: () => { token = ""; },
  };
}

export async function loadAppManagedProvider(): Promise<AppManagedProvider> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new AppManagedAuthError("m365_platform_unsupported", "App-managed M365 authorization requires Windows.");
  }
  const root = path.join(process.env.LOCALAPPDATA, "Microsoft", "Copilot", "User Data", "CopilotCodingHome");
  const profiles: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(path.join(root, entry.name, "data.db"));
      profiles.push(entry.name);
    } catch {}
  }
  const profile = selectAppManagedProfile(profiles, process.env.M365_LLMAPI_PROFILE);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(root, profile, "data.db"), { readOnly: true });
  let settings: Record<string, unknown>;
  try {
    db.exec("PRAGMA query_only=ON");
    const row = db.prepare("SELECT settings_json FROM model_providers WHERE id = ? AND type = ?").get(PROVIDER, "anthropic");
    if (!row || typeof row.settings_json !== "string") {
      throw new AppManagedAuthError("m365_provider_unavailable", "Initialize a Claude Code session in the M365 Copilot app.");
    }
    settings = JSON.parse(row.settings_json);
  } finally {
    db.close();
  }
  return decodeAppManagedProvider(settings);
}
