import { describe, expect, it, vi } from "vitest";
import { decodeAppManagedProvider, selectAppManagedProfile } from "./llmapi-app-managed.js";

const headers = {
  "X-ClientScenario": "Code",
  "X-ClientType": "Copilot",
  "X-ClientFeature": "LlmApiProxy",
  "X-Llm-Api-Version": "2026-09-22",
};
const settings = {
  baseUrl: "https://loki.delve.office.com/api/v1/llmapi",
  headersJson: JSON.stringify({ ...headers, Cookie: "never-forward", "X-ScenarioGUID": "never-forward" }),
  authorizationProtected: "v1.dpapi.test-fixture",
};
const token = (exp: number) => `test.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;

describe("app-managed M365 provider", () => {
  it("requires unambiguous or explicit profile selection without accepting path traversal", () => {
    expect(selectAppManagedProfile(["one"])).toBe("one");
    expect(selectAppManagedProfile(["one", "two"], "two")).toBe("two");
    expect(() => selectAppManagedProfile([])).toThrow("Select one initialized");
    expect(() => selectAppManagedProfile(["one", "two"])).toThrow("Select one initialized");
    for (const name of ["", ".", "..", "..\\one", "../one", "missing"]) {
      expect(() => selectAppManagedProfile(["one"], name)).toThrow("unavailable");
    }
  });

  it("uses only the registered metadata and releases its authorization reference", async () => {
    const bearer = token(2000);
    const recover = vi.fn().mockResolvedValue(JSON.stringify(`Bearer ${bearer}`));
    const provider = await decodeAppManagedProvider(settings, recover, 1000_000);
    expect(recover).toHaveBeenCalledWith(settings.authorizationProtected);
    expect(provider.headers).toEqual(headers);
    expect(provider.getToken()).toBe(bearer);
    provider.dispose();
    expect(provider.getToken()).toBe("");
  });

  it("accepts a raw JWT without inventing a different token or metadata", async () => {
    const bearer = token(2000);
    const provider = await decodeAppManagedProvider({ ...settings, headersJson: headers }, async () => bearer, 1000_000);
    expect(provider.getToken()).toBe(bearer);
    provider.dispose();
  });

  it.each([
    "https://unexpected.invalid/api/v1/llmapi",
    "https://loki.delve.office.com/api/v1/llmapi?redirect=elsewhere",
    "https://someone@loki.delve.office.com/api/v1/llmapi",
    "https://loki.delve.office.com/another-api",
  ])("rejects an unexpected gateway before recovering credentials", async (baseUrl) => {
    const recover = vi.fn();
    await expect(decodeAppManagedProvider({ ...settings, baseUrl }, recover)).rejects.toMatchObject({ code: "m365_gateway_invalid" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("rejects invalid metadata before recovering credentials", async () => {
    const recover = vi.fn();
    await expect(decodeAppManagedProvider({
      ...settings, headersJson: { ...headers, "X-ClientScenario": "Code\ninjected" },
    }, recover)).rejects.toMatchObject({ code: "m365_provider_invalid" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("reports expired authorization without exporting the recovered credential", async () => {
    const bearer = token(1000);
    try {
      await decodeAppManagedProvider(settings, async () => `Bearer ${bearer}`, 1000_000);
      throw new Error("Expected expired authorization");
    } catch (error) {
      expect(error).toMatchObject({ code: "m365_authorization_expired" });
      expect(String(error)).not.toContain(bearer);
    }
  });

  it("does not fall back to another credential format or plaintext cache", async () => {
    await expect(decodeAppManagedProvider({
      ...settings, authorizationProtected: "unsupported-format",
    })).rejects.toMatchObject({ code: "m365_authorization_format" });
  });

  it("rejects malformed or missing authorization", async () => {
    await expect(decodeAppManagedProvider(settings, async () => "not a credential")).rejects.toMatchObject({ code: "m365_authorization_format" });
    await expect(decodeAppManagedProvider({ ...settings, authorizationProtected: undefined })).rejects.toMatchObject({ code: "m365_authorization_unavailable" });
  });
});
