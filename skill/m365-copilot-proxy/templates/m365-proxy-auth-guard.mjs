import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const COOLDOWN_MS = 60 * 60 * 1000;
const phases = new Set([
  "healthy", "expired", "unavailable", "client-key-unavailable",
  "client-rejected", "upstream-unavailable", "invalid-model-response",
  "opening-app", "app-open-failed", "awaiting-sign-in",
]);

export async function probeAuthorization({ keyFile, fetchImpl = fetch }) {
  let key;
  try {
    key = (await readFile(keyFile, "utf8")).trim();
    if (!key) return "client-key-unavailable";
  } catch {
    return "client-key-unavailable";
  }
  try {
    const response = await fetchImpl("http://127.0.0.1:4141/v1/models", {
      headers: { "x-api-key": key },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    key = "";
    if (response.status === 401 || response.status === 403) return "client-rejected";
    let data;
    try {
      data = await response.json();
    } catch {
      return "invalid-model-response";
    }
    if (response.status === 200 && Array.isArray(data?.data) && data.data.length > 0) return "healthy";
    if (response.status === 503 && data?.error?.code === "m365_authorization_expired") return "expired";
    return "upstream-unavailable";
  } catch {
    return "unavailable";
  } finally {
    key = "";
  }
}

export async function recoverAuthorization({
  probe, activate, persist, emit, state = {}, now = Date.now, pause = sleep,
  pollAttempts = 6, pollMs = 10000,
}) {
  const saved = {
    phase: phases.has(state.phase) ? state.phase : null,
    lastAttempt: Number.isFinite(state.lastAttempt) ? state.lastAttempt : 0,
  };
  async function record(phase) {
    if (saved.phase === phase) return;
    saved.phase = phase;
    await persist(saved);
    await emit(phase);
  }
  async function healthy() {
    const changed = saved.phase !== "healthy";
    saved.phase = "healthy";
    saved.lastAttempt = 0;
    await persist(saved);
    if (changed) await emit("healthy");
    return saved;
  }
  const first = await probe();
  if (first === "healthy") return healthy();
  if (first !== "expired") {
    await record(first);
    return saved;
  }
  if (saved.lastAttempt && now() - saved.lastAttempt < COOLDOWN_MS) {
    await record("awaiting-sign-in");
    return saved;
  }
  // Persist before launch so a crash or a subsequent task cannot create a popup loop.
  saved.lastAttempt = now();
  saved.phase = "opening-app";
  await persist(saved);
  await emit("opening-app");
  try {
    await activate();
  } catch {
    await record("app-open-failed");
    return saved;
  }
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await pause(pollMs);
    const result = await probe();
    if (result === "healthy") return healthy();
    if (result !== "expired") {
      await record(result);
      return saved;
    }
  }
  await record("awaiting-sign-in");
  return saved;
}

async function main() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA || !process.env.USERPROFILE) {
    throw new Error("The M365 authorization guard requires Windows and the interactive user profile.");
  }
  const root = path.join(process.env.LOCALAPPDATA, "m365-copilot-proxy", ".state", "llmapi");
  await mkdir(root, { recursive: true });
  const stateFile = path.join(root, "auth-guard.json");
  const logFile = path.join(root, "auth-guard.log");
  let state = {};
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
    if (!state || typeof state !== "object") state = {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const emit = async (phase) => {
    try {
      if ((await stat(logFile)).size > 512 * 1024) await rename(logFile, `${logFile}.previous`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await appendFile(logFile, `${JSON.stringify({ time: new Date().toISOString(), phase })}\n`);
  };
  const persist = async (value) => {
    const pending = `${stateFile}.tmp`;
    await writeFile(pending, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(pending, stateFile);
  };
  const activate = async () => {
    const script = "Start-Process -FilePath (Join-Path $env:USERPROFILE '.local\\bin\\m365-code.lnk')";
    await promisify(execFile)(
      path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`],
      { windowsHide: true, timeout: 15000 },
    );
  };
  const result = await recoverAuthorization({
    state, persist, emit, activate,
    probe: () => probeAuthorization({ keyFile: path.join(root, "client-key") }),
  });
  if (result.phase === "app-open-failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("M365 authorization guard failed. Check its task result and local state files.");
    process.exitCode = 1;
  });
}
