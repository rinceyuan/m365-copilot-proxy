import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { probeAuthorization, recoverAuthorization } from "../templates/m365-proxy-auth-guard.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "m365-auth-guard-test-"));
const keyFile = path.join(root, "local-test-key");
await writeFile(keyFile, "test-loopback-client-key\n");
after(() => rm(root, { recursive: true }));

test("the probe authenticates only to loopback and rejects redirects", async () => {
  const result = await probeAuthorization({
    keyFile,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:4141/v1/models");
      assert.equal(options.headers["x-api-key"], "test-loopback-client-key");
      assert.equal(options.redirect, "error");
      return Response.json({ data: [{ id: "test-model" }] });
    },
  });
  assert.equal(result, "healthy");
});

test("only exact authorization expiry can trigger app recovery", async () => {
  for (const [status, code, expected] of [
    [503, "m365_authorization_expired", "expired"],
    [503, "m365_authorization_unavailable", "upstream-unavailable"],
    [429, "m365_throttled", "upstream-unavailable"],
    [401, "invalid_api_key", "client-rejected"],
    [403, "forbidden", "client-rejected"],
  ]) {
    const result = await probeAuthorization({
      keyFile,
      fetchImpl: async () => Response.json({ error: { code } }, { status }),
    });
    assert.equal(result, expected);
  }
  assert.equal(await probeAuthorization({
    keyFile, fetchImpl: async () => { throw new Error("offline"); },
  }), "unavailable");
  assert.equal(await probeAuthorization({
    keyFile: path.join(root, "missing"), fetchImpl: () => assert.fail("must not request without key"),
  }), "client-key-unavailable");
  assert.equal(await probeAuthorization({
    keyFile, fetchImpl: async () => Response.json({ data: [] }),
  }), "upstream-unavailable");
  assert.equal(await probeAuthorization({
    keyFile, fetchImpl: async () => new Response("not JSON"),
  }), "invalid-model-response");
});

function harness(results, state = {}) {
  const events = [];
  let launches = 0;
  let stored;
  return {
    events,
    get launches() { return launches; },
    get stored() { return stored; },
    options: {
      state, now: () => 10_000_000, pollAttempts: 2,
      probe: async () => results.length > 1 ? results.shift() : results[0],
      activate: async () => { launches++; },
      pause: async () => {},
      persist: async (value) => { stored = structuredClone(value); },
      emit: async (phase) => { events.push(phase); },
    },
  };
}

test("expired authorization opens the app once and confirms actual recovery", async () => {
  const h = harness(["expired", "expired", "healthy"]);
  const result = await recoverAuthorization(h.options);
  assert.equal(h.launches, 1);
  assert.equal(result.phase, "healthy");
  assert.equal(result.lastAttempt, 0);
  assert.deepEqual(h.events, ["opening-app", "healthy"]);
  assert.deepEqual(h.stored, result);
});

test("failed renewal persists a cooldown across task invocations", async () => {
  const h = harness(["expired"]);
  const result = await recoverAuthorization(h.options);
  assert.equal(result.phase, "awaiting-sign-in");
  assert.equal(h.launches, 1);
  const next = harness(["expired"], result);
  await recoverAuthorization(next.options);
  assert.equal(next.launches, 0);
  assert.deepEqual(next.events, []);
  next.options.now = () => result.lastAttempt + 60 * 60 * 1000;
  await recoverAuthorization(next.options);
  assert.equal(next.launches, 1);
});

test("healthy checks reset cooldown without opening an app or duplicating logs", async () => {
  const h = harness(["healthy"], { phase: "awaiting-sign-in", lastAttempt: 10 });
  const result = await recoverAuthorization(h.options);
  assert.equal(result.lastAttempt, 0);
  assert.equal(h.launches, 0);
  assert.deepEqual(h.events, ["healthy"]);
  const next = harness(["healthy"], result);
  await recoverAuthorization(next.options);
  assert.deepEqual(next.events, []);
});

test("network, client-key and upstream failures do not cause app popups", async () => {
  for (const phase of ["unavailable", "client-key-unavailable", "client-rejected", "upstream-unavailable", "invalid-model-response"]) {
    const h = harness([phase], { lastAttempt: 42 });
    const result = await recoverAuthorization(h.options);
    assert.equal(h.launches, 0);
    assert.equal(result.phase, phase);
    assert.equal(result.lastAttempt, 42);
  }
});

test("activation failure keeps its cooldown and does not poll", async () => {
  const h = harness(["expired"]);
  let probes = 0;
  h.options.probe = async () => { probes++; return "expired"; };
  h.options.activate = async () => {
    assert.equal(h.stored.phase, "opening-app");
    assert.equal(h.stored.lastAttempt, h.options.now());
    throw new Error("app not installed");
  };
  const result = await recoverAuthorization(h.options);
  assert.equal(result.phase, "app-open-failed");
  assert.equal(probes, 1);
});

test("loss of connectivity during recovery is not reported as healthy", async () => {
  const h = harness(["expired", "unavailable"]);
  const result = await recoverAuthorization(h.options);
  assert.equal(result.phase, "unavailable");
  assert.equal(h.launches, 1);
  assert.ok(result.lastAttempt > 0);
});
