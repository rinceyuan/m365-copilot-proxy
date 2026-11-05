"use strict";
const net = require("node:net");

const PROXY_HOST = process.env.M365_AUTO_PROXY_HOST || "127.0.0.1";
const PROXY_PORT = Number(process.env.M365_AUTO_PROXY_PORT || "7897");
const PROBE_TIMEOUT_MS = 150;
const CACHE_TTL_MS = 2000;

const sym1 = Symbol.for("undici.globalDispatcher.1");
const sym2 = Symbol.for("undici.globalDispatcher.2");

const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
let proxyDispatcher = null;
let directDispatcher = null;

function ensureDispatchers() {
  if (proxyDispatcher && directDispatcher) return true;
  const current = globalThis[sym1] || globalThis[sym2];
  if (!current) return false;
  const noProxySym = Object.getOwnPropertySymbols(current).find((s) => s.description === "no proxy agent");
  if (!noProxySym || !current[noProxySym]) return false;
  proxyDispatcher = current;
  directDispatcher = current[noProxySym];
  return true;
}

let cachedAlive = null;
let cachedAt = 0;
let lastMode = null;

function probeProxyPort(host = PROXY_HOST, port = PROXY_PORT, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function isProxyAvailable(force = false) {
  const now = Date.now();
  if (!force && cachedAlive !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedAlive;
  }
  const alive = await probeProxyPort();
  cachedAlive = alive;
  cachedAt = Date.now();
  return alive;
}

function applyDispatcher(useProxy) {
  if (!proxyDispatcher || !directDispatcher) return;
  const target = useProxy ? proxyDispatcher : directDispatcher;
  if (globalThis[sym1]) globalThis[sym1] = target;
  if (globalThis[sym2]) globalThis[sym2] = target;
  const mode = useProxy ? "proxy" : "direct";
  if (mode !== lastMode) {
    lastMode = mode;
    process.stderr.write(
      `[m365-proxy-auto-egress] Switched outbound mode to ${mode.toUpperCase()} (${PROXY_HOST}:${PROXY_PORT} ${useProxy ? "reachable" : "unreachable"})\n`,
    );
  }
}

function isProxyRefusedError(err) {
  const code = err?.cause?.code || err?.code || "";
  const msg = `${err?.message || ""} ${err?.cause?.message || ""}`;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    msg.includes(`${PROXY_HOST}:${PROXY_PORT}`) ||
    msg.includes("ECONNREFUSED")
  );
}

if (originalFetch) {
  globalThis.fetch = async function autoEgressFetch(input, init) {
    if (!ensureDispatchers()) {
      return originalFetch(input, init);
    }
    const useProxy = await isProxyAvailable(false);
    const dispatcher = useProxy ? proxyDispatcher : directDispatcher;
    applyDispatcher(useProxy);
    try {
      return await originalFetch(input, { ...init, dispatcher });
    } catch (err) {
      if (useProxy && isProxyRefusedError(err)) {
        const stillAlive = await isProxyAvailable(true);
        if (!stillAlive) {
          applyDispatcher(false);
          return await originalFetch(input, { ...init, dispatcher: directDispatcher });
        }
      }
      throw err;
    }
  };
}
