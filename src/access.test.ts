import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Fastify from "fastify";
import { createAccessControl, redactToken, urlPrefix } from "./access.ts";
import { ChannelService } from "./channels.ts";
import { channelSchema, type ChannelDef, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { testConfig } from "./testing/harness.ts";

const root = mkdtempSync(join(tmpdir(), "channels-access-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "test_token_0123456789abcdef";
const LOCAL = "127.0.0.1:7654";
const PUBLIC = "box.tailnet.ts.net";

/** One representative path per category the guard distinguishes. */
const PATHS = {
  manifest: "/manifest.json",
  catalog: "/catalog/tv/channels.json",
  feed: "/ch/sitcoms/live.m3u8",
  health: "/health",
  guide: "/guide",
  watch: "/watch",
  viewerGuide: "/viewer/guide.json",
  viewerTune: "/viewer/tune/sitcoms",
  viewerAsset: "/watch/hls.js",
  api: "/api/channels",
  debug: "/debug/hls",
  ui: "/ui",
  root: "/",
};

/**
 * A stand-in for the real server: `src/server.ts` opens a database and binds a port at
 * import time, so it cannot be pulled into a unit test. What matters here is the wiring
 * order — `rewriteUrl` before routing, the guard as the first hook — which this
 * reproduces exactly. Handlers echo the URL they were reached at, so the tests can also
 * assert the token was stripped before routing.
 */
function makeApp(overrides: Partial<Config> = {}) {
  const config = testConfig(join(root, "app"), overrides);
  const access = createAccessControl(config);
  const app = Fastify({ rewriteUrl: access.rewriteUrl });
  app.addHook("onRequest", access.guard);
  app.addHook("onRequest", access.throttle);
  app.addHook("onSend", async (req, reply) => {
    if (access.corsAllowed(req.url)) reply.header("Access-Control-Allow-Origin", "*");
  });
  for (const path of Object.values(PATHS)) app.get(path, async (req) => ({ saw: req.url }));
  app.options("/*", async (_req, reply) => reply.code(204).send());
  return app;
}

function get(app: ReturnType<typeof makeApp>, url: string, host: string, headers = {}) {
  return app.inject({ method: "GET", url, headers: { host, ...headers } });
}

describe("access control, no token configured", () => {
  it("leaves every path open to every host", async () => {
    const app = makeApp();
    for (const host of [LOCAL, PUBLIC]) {
      for (const path of Object.values(PATHS)) {
        const res = await get(app, path, host);
        assert.equal(res.statusCode, 200, `${host} ${path}`);
      }
    }
    await app.close();
  });
});

describe("access control, token configured", () => {
  it("serves everything unprefixed to a local host", async () => {
    const app = makeApp({ accessToken: TOKEN });
    for (const path of Object.values(PATHS)) {
      assert.equal((await get(app, path, LOCAL)).statusCode, 200, path);
    }
    await app.close();
  });

  it("refuses a remote host that presents no token", async () => {
    const app = makeApp({ accessToken: TOKEN });
    for (const path of Object.values(PATHS)) {
      assert.equal((await get(app, path, PUBLIC)).statusCode, 404, path);
    }
    const preflight = await app.inject({
      method: "OPTIONS",
      url: PATHS.manifest,
      headers: { host: PUBLIC },
    });
    assert.equal(preflight.statusCode, 404);
    await app.close();
  });

  it("serves only the addon and feed paths to a remote host that presents the token", async () => {
    const app = makeApp({ accessToken: TOKEN });
    for (const path of [
      PATHS.manifest,
      PATHS.catalog,
      PATHS.feed,
      PATHS.health,
      PATHS.guide,
      PATHS.watch,
      PATHS.viewerGuide,
      PATHS.viewerTune,
      PATHS.viewerAsset,
    ]) {
      assert.equal((await get(app, `/${TOKEN}${path}`, PUBLIC)).statusCode, 200, path);
    }
    for (const path of [PATHS.api, PATHS.debug, PATHS.ui, PATHS.root]) {
      assert.equal((await get(app, `/${TOKEN}${path}`, PUBLIC)).statusCode, 404, path);
    }
    await app.close();
  });

  it("limits the remote viewer surface to read-only methods", async () => {
    const app = makeApp({ accessToken: TOKEN });
    for (const path of [PATHS.watch, PATHS.viewerGuide, PATHS.viewerTune, PATHS.viewerAsset, PATHS.feed]) {
      const res = await app.inject({
        method: "POST",
        url: `/${TOKEN}${path}`,
        headers: { host: PUBLIC },
      });
      assert.equal(res.statusCode, 404, path);
    }
    await app.close();
  });

  it("rejects a token that is the right length or a prefix of the real one", async () => {
    const app = makeApp({ accessToken: TOKEN });
    const sameLength = `${TOKEN.slice(0, -1)}z`;
    assert.equal(sameLength.length, TOKEN.length);
    for (const wrong of [sameLength, TOKEN.slice(0, -1), `${TOKEN}x`, "", "nonsense"]) {
      const res = await get(app, `/${wrong}${PATHS.manifest}`, PUBLIC);
      assert.equal(res.statusCode, 404, wrong);
    }
    await app.close();
  });

  it("strips the token before routing", async () => {
    const app = makeApp({ accessToken: TOKEN });

    // The debug ring buffer filters on `req.url.startsWith("/ch/")`, and the HLS master
    // playlist emits URIs relative to the request path. Both break if the token survives.
    const feed = await get(app, `/${TOKEN}${PATHS.feed}`, PUBLIC);
    assert.equal(feed.json().saw, PATHS.feed);

    const query = await get(app, `/${TOKEN}${PATHS.catalog}?skip=10`, PUBLIC);
    assert.equal(query.json().saw, `${PATHS.catalog}?skip=10`);

    // The bare prefix with nothing after it still has to name a path.
    assert.equal((await get(app, `/${TOKEN}`, LOCAL)).json().saw, "/");

    await app.close();
  });

  it("treats a spoofed local Host behind a proxy as remote", async () => {
    const app = makeApp({ accessToken: TOKEN });

    // Tailscale Funnel routes on the TLS SNI and relays the client's Host verbatim, so
    // this is what an attacker sends to reach the editor API. The forwarding header the
    // proxy adds is what gives them away.
    for (const header of [
      { "x-forwarded-for": "1.2.3.4" },
      { "x-forwarded-proto": "https" },
      { "cf-connecting-ip": "1.2.3.4" },
      { "tailscale-user-login": "someone@example.com" },
    ]) {
      const res = await get(app, PATHS.api, LOCAL, header);
      assert.equal(res.statusCode, 404, Object.keys(header)[0]);
    }
    await app.close();
  });

  it("treats a non-loopback connection claiming a local Host as remote", async () => {
    const app = makeApp({ accessToken: TOKEN });
    // DNS rebinding: a hostile page resolves its own name to 127.0.0.1 and the browser
    // sends that Host, but the packet does not come from this machine.
    const res = await app.inject({
      method: "GET",
      url: PATHS.api,
      headers: { host: LOCAL },
      remoteAddress: "192.168.1.99",
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  it("gives a trusted host the full local surface, over the network", async () => {
    const app = makeApp({ accessToken: TOKEN, trustedHosts: ["192.168.1.58:7654"] });
    const res = await app.inject({
      method: "GET",
      url: PATHS.api,
      headers: { host: "192.168.1.58:7654" },
      remoteAddress: "192.168.1.99",
    });
    assert.equal(res.statusCode, 200);

    // A neighbouring address on the same LAN is still remote.
    const other = await get(app, PATHS.api, "192.168.1.59:7654");
    assert.equal(other.statusCode, 404);
    await app.close();
  });

  it("answers a refusal with a bare 404, disclosing nothing", async () => {
    const app = makeApp({ accessToken: TOKEN });
    const res = await get(app, PATHS.api, PUBLIC);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body, "not found");
    assert.match(res.headers["content-type"] as string, /text\/plain/);
    await app.close();
  });

  it("slows and closes repeated failed-token connections without changing the 404", async () => {
    const app = makeApp({ accessToken: TOKEN, authFailureLimit: 1 });
    const first = await get(app, `/wrong${PATHS.manifest}`, PUBLIC);
    assert.equal(first.statusCode, 404);
    const started = Date.now();
    const limited = await get(app, `/still-wrong${PATHS.manifest}`, PUBLIC);
    assert.equal(limited.statusCode, 404);
    assert.equal(limited.body, "not found");
    assert.equal(limited.headers.connection, "close");
    assert.ok(Date.now() - started >= 200);
    await app.close();
  });

  it("limits remote tune/session allocation while leaving ordinary reads available", async () => {
    const app = makeApp({ accessToken: TOKEN, tuneRequestLimitPerMinute: 2 });
    for (let index = 0; index < 2; index++) {
      assert.equal((await get(app, `/${TOKEN}${PATHS.viewerTune}`, PUBLIC)).statusCode, 200);
    }
    const limited = await get(app, `/${TOKEN}${PATHS.viewerTune}`, PUBLIC);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal((await get(app, `/${TOKEN}${PATHS.viewerGuide}`, PUBLIC)).statusCode, 200);
    await app.close();
  });
});

describe("CORS scoping", () => {
  it("sends a wildcard origin for addon paths but never for the editor API", async () => {
    const app = makeApp();
    for (const path of [PATHS.manifest, PATHS.watch, PATHS.viewerGuide]) {
      const publicPath = await get(app, path, LOCAL);
      assert.equal(publicPath.headers["access-control-allow-origin"], "*", path);
    }

    // Without a token configured either, because the risk is a browser the operator is
    // already running, not a remote caller.
    for (const path of [PATHS.api, PATHS.debug, PATHS.ui]) {
      const res = await get(app, path, LOCAL);
      assert.equal(res.headers["access-control-allow-origin"], undefined, path);
    }
    await app.close();
  });
});

describe("token in generated URLs", () => {
  function service(name: string, config: Config) {
    const db = openDb(config.dataDir);
    const channel: ChannelDef = channelSchema.parse({
      id: name,
      name,
      strategy: "shuffle",
      seed: 1,
      content: [{ type: "movie", id: "tt5000001" }],
    });
    return { db, svc: new ChannelService([channel], db, config) };
  }

  it("prefixes the stream URL handed to Stremio", async () => {
    const config = testConfig(join(root, "stream-token"), {
      accessToken: TOKEN,
      publicBaseUrl: "https://box.tailnet.ts.net",
    });
    const { db, svc } = service("sitcoms", config);
    assert.equal(
      svc.streamUrl("sitcoms"),
      `https://box.tailnet.ts.net/${TOKEN}/ch/sitcoms/live.m3u8`,
    );
    svc.feeds.stopAll("test complete");
    db.close();
  });

  it("leaves the stream URL untouched when no token is configured", async () => {
    const config = testConfig(join(root, "stream-plain"), {
      publicBaseUrl: "http://192.168.1.58:7654",
    });
    const { db, svc } = service("sitcoms", config);
    assert.equal(svc.streamUrl("sitcoms"), "http://192.168.1.58:7654/ch/sitcoms/live.m3u8");
    svc.feeds.stopAll("test complete");
    db.close();
  });

  it("masks the token in diagnostic output", () => {
    const config = testConfig(join(root, "redact"), { accessToken: TOKEN });
    assert.equal(
      redactToken(config, `https://box.ts.net/${TOKEN}/ch/a/live.m3u8`),
      "https://box.ts.net/<token>/ch/a/live.m3u8",
    );
    assert.equal(urlPrefix(config), `/${TOKEN}`);

    const plain = testConfig(join(root, "redact-plain"));
    assert.equal(redactToken(plain, "https://box.ts.net/ch/a/live.m3u8"), "https://box.ts.net/ch/a/live.m3u8");
    assert.equal(urlPrefix(plain), "");
  });
});
