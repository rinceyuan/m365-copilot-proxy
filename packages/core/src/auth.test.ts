import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: () => false,
  mkdirSync: vi.fn(),
}));
vi.mock("./log.js", () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: vi.fn() },
}));
vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    getTokenCache() {
      return { getAllAccounts: async () => [] };
    }
    async getAuthCodeUrl() {
      return "https://example.invalid/login";
    }
  },
  CryptoProvider: class {
    async generatePkceCodes() {
      return { verifier: "verifier", challenge: "challenge" };
    }
  },
}));

const launchFailure = new Error("Stop before login");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.stubEnv("CHROMIUM_PATH", "");
  vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "1");
  vi.stubEnv("M365_NO_INTERACTIVE", "0");
  vi.mocked(chromium.launchPersistentContext).mockRejectedValue(launchFailure);
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error("Browser not on PATH");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(["automated", "interactive"] as const)("%s login browser", (mode) => {
  async function launchOptions() {
    const auth = await import("./auth.js");
    const login = mode === "automated"
      ? auth.loginAutomated("test@example.invalid", "unused", "unused")
      : auth.getToken();
    await expect(login).rejects.toBe(launchFailure);
    expect(chromium.launchPersistentContext).toHaveBeenCalledOnce();
    return vi.mocked(chromium.launchPersistentContext).mock.calls[0][1]!;
  }

  it("defaults to Edge on Windows without searching for Chromium", async () => {
    const options = await launchOptions();
    expect(options.channel).toBe("msedge");
    expect(options.executablePath).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("lets an explicit browser path override Edge", async () => {
    vi.stubEnv("CHROMIUM_PATH", "C:\\custom-browser\\chrome.exe");
    const options = await launchOptions();
    expect(options.executablePath).toBe("C:\\custom-browser\\chrome.exe");
    expect(options.channel).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("keeps the system Chromium selection outside Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.mocked(execSync).mockReturnValue(Buffer.from("/usr/bin/chromium\n"));
    const options = await launchOptions();
    expect(options.executablePath).toBe("/usr/bin/chromium");
    expect(options.channel).toBeUndefined();
  });

  it("keeps the bundled-browser fallback outside Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const options = await launchOptions();
    expect(options.executablePath).toBeUndefined();
    expect(options.channel).toBeUndefined();
  });
});
