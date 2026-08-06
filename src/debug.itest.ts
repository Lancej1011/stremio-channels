/**
 * Integration tests for the diagnostics endpoint.
 *
 * This endpoint exists to explain a failure on a device nobody here can test. That makes
 * its own robustness load-bearing: if it throws because a channel was never tuned, or
 * because a feed was stopped between two of its own reads, the one tool for diagnosing
 * the TV is the thing that breaks. So it is exercised here in every state a channel can
 * actually be in.
 *
 * Run with `npm run test:integration`.
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ChannelService } from "./channels.ts";
import { channelSchema, type ChannelDef, type Config } from "./config.ts";
import { registerDebug } from "./debug.ts";
import { openDb, type Db } from "./db.ts";
import { makeClip, recordingLogger, sleep, testConfig } from "./testing/harness.ts";

const PROGRAM_MS = 120_000;
const root = mkdtempSync(join(tmpdir(), "chan-debug-itest-"));
let clip = "";

before(async () => {
  clip = await makeClip(join(root, "program.mp4"), { seconds: 150 });
}, { timeout: 120_000 });

after(() => rmSync(root, { recursive: true, force: true }));

function channel(id: string, imdb: string): ChannelDef {
  return channelSchema.parse({ id, name: id, seed: 1, content: [{ type: "movie", id: imdb }] });
}

function seedProgram(db: Db, channelId: string, imdb: string): void {
  db.insertPrograms([{
    channel_id: channelId, slot_index: 0, start_ms: Date.now() - 10_000,
    duration_ms: PROGRAM_MS, ref_key: imdb, title: `On ${channelId}`,
    resolved_url: clip, url_expires_at: Date.now() + 3600_000,
    daypart: null, torrent_id: null, file_id: null,
  }]);
  db.putProbe({
    ref_key: imdb, duration_ms: PROGRAM_MS, video_codec: "h264",
    audio_codec: "aac", probed_at: Date.now(),
  });
}

/** Service plus a Fastify app carrying only the debug routes. */
function build(dataDir: string, overrides: Partial<Config> = {}) {
  const db = openDb(dataDir);
  const config = testConfig(dataDir, { scheduleHorizonHours: 0.01, ...overrides });
  seedProgram(db, "one", "tt7000001");
  const service = new ChannelService(
    [channel("one", "tt7000001")],
    db,
    config,
    recordingLogger().log,
  );
  const app = Fastify({ logger: false });
  registerDebug(app, service, config);
  return { db, config, service, app };
}

async function get(app: ReturnType<typeof build>["app"], url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe("debug endpoint", { timeout: 180_000 }, () => {
  it("describes a channel that has never been tuned", async () => {
    // The most likely state when a user first goes looking: nothing is running, and the
    // endpoint still has to answer rather than fall over on a missing feed.
    const { db, app, service } = build(join(root, "cold"));
    try {
      const { status, body } = await get(app, "/debug/hls/one");
      assert.equal(status, 200);
      assert.equal(body.running, false);
      assert.equal(body.measured, null);
      assert.equal(body.probed, null);
      assert.equal(body.media, null);
      assert.equal(body.mediaInfo, null);
      // The computed string still has to be there, because it is what a cold tune-in
      // would advertise.
      assert.equal((body.advertised as Record<string, string>).source, "computed");
      assert.equal((body.advertised as Record<string, string>).video, "avc1.64000c");
      // No measurement means nothing to disagree with.
      assert.equal(body.codecsAgree, true);
      assert.ok(typeof body.master === "string" && (body.master as string).includes("STREAM-INF"));
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("flags a loopback stream URL, which no TV can reach", async () => {
    const { db, app, service } = build(join(root, "loopback"));
    try {
      const { body } = await get(app, "/debug/hls/one");
      assert.equal(body.publicBaseUrlIsLoopback, true);
      assert.equal(body.publicBaseUrlExplicit, false);
      assert.match(String((body.stream as Record<string, string>).url), /^http:\/\/127\.0\.0\.1/);
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("clears the loopback flag once a reachable base URL is configured", async () => {
    const { db, app, service } = build(join(root, "reachable"), {
      publicBaseUrl: "http://192.168.1.50:7654",
    });
    try {
      const { body } = await get(app, "/debug/hls/one");
      assert.equal(body.publicBaseUrlIsLoopback, false);
      assert.equal(body.publicBaseUrlExplicit, true);
      assert.equal(
        (body.stream as Record<string, string>).url,
        "http://192.168.1.50:7654/ch/one/live.m3u8",
      );
      assert.equal(body.accessTokenConfigured, false);
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("masks the access token in output meant to be pasted into a bug report", async () => {
    const token = "itest_token_0123456789abcdef";
    const { db, app, service } = build(join(root, "tokened"), {
      accessToken: token,
      publicBaseUrl: "https://box.tailnet.ts.net",
    });
    try {
      const { body } = await get(app, "/debug/hls/one");
      assert.equal(body.accessTokenConfigured, true);
      const url = String((body.stream as Record<string, string>).url);
      assert.equal(url, "https://box.tailnet.ts.net/<token>/ch/one/live.m3u8");
      assert.ok(!JSON.stringify(body).includes(token), "token leaked into the debug payload");
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("describes a live channel with real segments on disk", async () => {
    const { db, app, service } = build(join(root, "live"));
    try {
      const feed = await service.feeds.claim("one");
      for (let i = 0; i < 60 && !feed.newestSegmentPath(); i++) await sleep(500);
      feed.ensureCodecsMeasured();
      for (let i = 0; i < 40 && !feed.measuredCodecs; i++) await sleep(250);

      const { body } = await get(app, "/debug/hls/one");
      assert.equal(body.running, true);
      assert.equal((body.advertised as Record<string, string>).source, "measured");
      assert.equal(body.codecsAgree, true, "measured and computed disagree on a real feed");

      const probed = body.probed as Record<string, unknown>;
      assert.equal(probed.videoCodec, "h264");
      assert.equal(probed.audioCodec, "aac");
      assert.equal(probed.width, 320);

      const info = body.mediaInfo as Record<string, unknown>;
      assert.ok((info.segmentCount as number) > 0);
      assert.equal(info.hasEndlist, false, "the playlist stopped looking live");
      assert.ok(typeof body.media === "string" && (body.media as string).startsWith("#EXTM3U"));
    } finally {
      service.feeds.stopAll("test complete");
      await sleep(300);
      db.close();
    }
  });

  it("keeps answering after the feed has been stopped", async () => {
    // An idle shutdown between the device failing and the user running curl is entirely
    // likely, and is exactly when the report matters most.
    const { db, app, service } = build(join(root, "stopped"));
    try {
      const feed = await service.feeds.claim("one");
      for (let i = 0; i < 40 && !feed.newestSegmentPath(); i++) await sleep(500);
      feed.stop("test");
      await sleep(300);

      const { status, body } = await get(app, "/debug/hls/one");
      assert.equal(status, 200);
      assert.equal(body.running, false);
      // Segments survive the stop, so there is still something to describe.
      assert.ok(body.media !== null, "the playlist vanished when the feed stopped");
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("records what a device asked for, including its Range and User-Agent", async () => {
    // This is the field that distinguishes "never reached the server" from "rejected the
    // manifest" from "decoder gave up", with no ADB available.
    const { db, app, service } = build(join(root, "ring"));
    try {
      app.get("/ch/:id/:file", async () => "ok");
      await app.inject({
        method: "GET",
        url: "/ch/one/live.m3u8",
        headers: { "user-agent": "ExoPlayer/2.18.1 (Linux;Android 11)" },
      });
      await app.inject({
        method: "GET",
        url: "/ch/one/seg000001.ts",
        headers: { range: "bytes=0-99", "user-agent": "ExoPlayer/2.18.1 (Linux;Android 11)" },
      });
      // A request to something else entirely must not pollute the feed's history.
      await app.inject({ method: "GET", url: "/debug/hls/one" });

      const { body } = await get(app, "/debug/hls/one");
      const requests = body.recentRequests as Record<string, unknown>[];
      assert.equal(requests.length, 2, `unexpected history: ${JSON.stringify(requests)}`);
      // Newest first, so the most recent attempt is what a reader sees.
      assert.equal(requests[0]!.path, "/ch/one/seg000001.ts");
      assert.equal(requests[0]!.range, "bytes=0-99");
      assert.match(String(requests[0]!.userAgent), /ExoPlayer/);
      assert.equal(requests[1]!.path, "/ch/one/live.m3u8");
      assert.equal(requests[1]!.range, null);
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("reports every channel in one request", async () => {
    const { db, app, service } = build(join(root, "all"));
    try {
      const { status, body } = await get(app, "/debug/hls");
      assert.equal(status, 200);
      const channels = body.channels as Record<string, unknown>[];
      assert.deepEqual(channels.map((c) => c.channelId), ["one"]);
      assert.ok(Array.isArray(body.recentRequests));
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("404s an unknown channel rather than describing a fiction", async () => {
    const { db, app, service } = build(join(root, "unknown"));
    try {
      const res = await app.inject({ method: "GET", url: "/debug/hls/nope" });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error: string }).error, "no such channel");
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });

  it("honours a codec override and says that is where the string came from", async () => {
    // The escape hatch for trying a value against a real device. If it silently did
    // nothing, a user would conclude the codec string was not the problem.
    const base = testConfig(join(root, "override"));
    const { db, app, service } = build(join(root, "override"), {
      hls: { ...base.hls, codecs: "avc1.4d4028,mp4a.40.2" },
    });
    try {
      const { body } = await get(app, "/debug/hls/one");
      const advertised = body.advertised as Record<string, string>;
      assert.equal(advertised.source, "config-override");
      assert.equal(advertised.combined, "avc1.4d4028,mp4a.40.2");
      assert.ok((body.master as string).includes('CODECS="avc1.4d4028,mp4a.40.2"'));
      // The computed value is still reported, so the override is visibly an override.
      assert.equal((body.computed as Record<string, string>).video, "avc1.64000c");
    } finally {
      service.feeds.stopAll("test complete");
      db.close();
    }
  });
});
