import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import Fastify from "fastify";
import { buildDebridAgent } from "./debrid-agent.ts";
import { DebridAgentClient } from "./content/providers/debrid-agent-client.ts";
import { resetRateLimitState } from "./content/providers/torbox.ts";

const AGENT_TOKEN = "agent_token_0123456789abcdef";
const AUTH = { authorization: `Bearer ${AGENT_TOKEN}` };
const HASH = "a".repeat(40);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRateLimitState();
});

describe("isolated debrid agent", () => {
  it("uses the broker token rather than a provider credential over the wire", async () => {
    const broker = Fastify();
    let authorization = "";
    broker.post("/v1/check-cached", async (req) => {
      authorization = req.headers.authorization ?? "";
      return { torrents: [{ hash: HASH, name: "release", size: 123 }] };
    });
    const address = await broker.listen({ host: "127.0.0.1", port: 0 });
    const client = new DebridAgentClient(address, AGENT_TOKEN);
    const found = await client.checkCached([HASH]);
    assert.equal(authorization, `Bearer ${AGENT_TOKEN}`);
    assert.equal(found.get(HASH)?.name, "release");
    await broker.close();
  });

  it("discloses no route or credential without its local capability token", async () => {
    const app = buildDebridAgent("provider-secret", AGENT_TOKEN);
    for (const authorization of [undefined, "Bearer wrong_token_0123456789abcdef"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/verify",
        headers: authorization ? { authorization } : {},
        payload: {},
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.body, "not found");
      assert.doesNotMatch(res.body, /provider|TorBox|token/i);
    }
    await app.close();
  });

  it("forwards bounded cache checks without returning the provider key", async () => {
    let requested = "";
    let bearer = "";
    globalThis.fetch = async (input, init) => {
      requested = String(input);
      bearer = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        success: true,
        data: [{ hash: HASH, name: "release", size: 123, files: [] }],
      }), { headers: { "content-type": "application/json" } });
    };
    const app = buildDebridAgent("provider-secret", AGENT_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/v1/check-cached",
      headers: AUTH,
      payload: { hashes: [HASH], withFiles: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(requested, /checkcached/);
    assert.equal(bearer, "Bearer provider-secret");
    assert.doesNotMatch(res.body, /provider-secret/);
    assert.equal(res.json().torrents[0].hash, HASH);
    await app.close();
  });

  it("rejects oversized work before making a provider request", async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error("should not run"); };
    const app = buildDebridAgent("provider-secret", AGENT_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/v1/check-cached",
      headers: AUTH,
      payload: { hashes: Array.from({ length: 101 }, () => HASH) },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
    await app.close();
  });
});
