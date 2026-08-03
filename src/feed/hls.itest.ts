/**
 * Integration tests for what an HLS client is actually served.
 *
 * The point of these is the two properties that cannot be checked by reading code: that
 * the advertised codec string matches the bytes ffmpeg really wrote, and that the master
 * playlist comes back fast enough that ExoPlayer will not abandon the request.
 *
 * Run with `npm run test:integration`.
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createReadStream, existsSync, readFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Config } from "../config.ts";
import { contentRange, parseRange, rangeLength } from "../range.ts";
import { makeClip, sleep, testConfig } from "../testing/harness.ts";
import { computeCodecs, measureCodecs, parseBitrateKbps } from "./codecs.ts";
import { masterPlaylist, parseMediaPlaylist } from "./playlist.ts";
import { PlaybackSession, type NextProgram } from "./supervisor.ts";

const root = mkdtempSync(join(tmpdir(), "chan-hls-itest-"));
let clip = "";

before(async () => {
  clip = await makeClip(join(root, "a.mp4"), { seconds: 90 });
}, { timeout: 120_000 });

after(() => rmSync(root, { recursive: true, force: true }));

function segmentNumbers(dir: string): number[] {
  return readdirSync(dir)
    .map((name) => /^seg(\d+)\.ts$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

function highestSegment(dir: string): number {
  return Math.max(-1, ...segmentNumbers(dir));
}

function lowestSegment(dir: string): number {
  return Math.min(Infinity, ...segmentNumbers(dir));
}

function provider(seconds: number): () => Promise<NextProgram | null> {
  return async () => ({
    title: "Program",
    source: { url: clip, offsetSeconds: 0, durationSeconds: seconds, hasAudio: true },
  });
}

/** Runs a feed until it has produced settled segments, then hands it to `body`. */
async function withFeed(
  config: Config,
  channelId: string,
  body: (feed: PlaybackSession) => Promise<void>,
): Promise<void> {
  const feed = new PlaybackSession(channelId, "test", config, provider(60));
  await feed.ensureStarted();
  try {
    for (let i = 0; i < 60 && !feed.newestSegmentPath(); i++) await sleep(500);
    assert.ok(feed.newestSegmentPath(), "the feed never produced a settled segment");
    await body(feed);
  } finally {
    feed.stop("test complete");
    await sleep(300);
  }
}

describe("codec advertising", { timeout: 180_000 }, () => {
  it("advertises exactly what ffmpeg wrote", async () => {
    // The drift test. One side is derived from config, the other read out of the avcC box
    // of a segment the encoder really produced. They must agree, or the master playlist
    // is describing the stream as something it is not — which is precisely what makes a
    // player refuse content it could have played.
    const config = testConfig(join(root, "drift"));
    await withFeed(config, "drift", async (feed) => {
      const measured = await measureCodecs(feed.newestSegmentPath()!);
      const computed = computeCodecs({
        width: config.video.width,
        height: config.video.height,
        fps: config.video.fps,
        bitrateKbps: parseBitrateKbps(config.video.bitrate),
        profile: config.video.profile,
        level: config.video.level,
      });

      assert.ok(measured, "could not read a codec string from a real segment");
      assert.equal(
        measured.combined,
        computed.combined,
        "the computed codec string has drifted from what the encoder emits",
      );
      // 320x240@15 400k High is level 1.2.
      assert.equal(measured.video, "avc1.64000c");
    });
  });

  it("follows the configured profile into the bitstream", async () => {
    // Proves video.profile is not merely passed to ffmpeg but lands in the SPS, and that
    // the constraint byte the computed string uses for Main is the one really written.
    const base = testConfig(join(root, "main"));
    const config = testConfig(join(root, "main"), {
      video: { ...base.video, profile: "main" },
    });
    await withFeed(config, "main", async (feed) => {
      const measured = await measureCodecs(feed.newestSegmentPath()!);
      assert.ok(measured);
      assert.ok(measured.video.startsWith("avc1.4d40"), `not Main profile: ${measured.video}`);

      // Level 1.3, not the 1.2 the same stream gets under High. Main has no 25% bitrate
      // allowance, so 400kbps exceeds level 1.2's 384kbps ceiling — and libx264 reaches
      // the same conclusion independently, which is what makes this worth asserting.
      assert.equal(
        measured.video,
        computeCodecs({
          width: config.video.width,
          height: config.video.height,
          fps: config.video.fps,
          bitrateKbps: parseBitrateKbps(config.video.bitrate),
          profile: "main",
          level: "auto",
        }).video,
        "the level table disagrees with libx264 about Main profile",
      );
      assert.equal(measured.video, "avc1.4d400d");
    });
  });

  it("lands a pinned level in the bitstream", async () => {
    // Guards the level_idc spelling: if the dotted form were passed through, a level of
    // 3.1 would arrive as something else entirely.
    const base = testConfig(join(root, "level"));
    const config = testConfig(join(root, "level"), {
      video: { ...base.video, level: "3.1" },
    });
    await withFeed(config, "level", async (feed) => {
      const measured = await measureCodecs(feed.newestSegmentPath()!);
      assert.ok(measured);
      assert.equal(measured.video, "avc1.64001f", "0x1f is level 3.1");
    });
  });

  it("measures the codec string in the background once a segment exists", async () => {
    const config = testConfig(join(root, "measure"));
    await withFeed(config, "measure", async (feed) => {
      // Read into a local first: asserting on the getter directly narrows its type to
      // `null` for the rest of the scope, and every later read becomes a type error.
      const beforeAsking = feed.measuredCodecs;
      assert.equal(beforeAsking, null, "measurement ran before it was asked for");
      feed.ensureCodecsMeasured();
      for (let i = 0; i < 40 && !feed.measuredCodecs; i++) await sleep(250);
      assert.equal(feed.measuredCodecs?.video, "avc1.64000c");
    });
  });
});

describe("program date time", { timeout: 180_000 }, () => {
  it("is absent by default and anchored to now when enabled", async () => {
    const off = testConfig(join(root, "pdt-off"));
    await withFeed(off, "pdt-off", async (feed) => {
      const info = parseMediaPlaylist(readFileSync(feed.playlistPath, "utf8"));
      assert.equal(info.hasProgramDateTime, false);
    });

    const base = testConfig(join(root, "pdt-on"));
    const on = testConfig(join(root, "pdt-on"), {
      hls: { ...base.hls, programDateTime: true },
    });
    await withFeed(on, "pdt-on", async (feed) => {
      const info = parseMediaPlaylist(readFileSync(feed.playlistPath, "utf8"));
      assert.equal(info.hasProgramDateTime, true, "the flag did not reach ffmpeg");

      // The real question, which passing the flag does not answer: the timestamps the
      // encoders stamp carry the pipeline's own cursor offset, so a date derived from
      // them could land hours from the actual time of day.
      const at = Date.parse(info.firstProgramDateTime!);
      assert.ok(Number.isFinite(at), `unparseable date ${info.firstProgramDateTime}`);
      const driftMinutes = Math.abs(at - Date.now()) / 60_000;
      assert.ok(
        driftMinutes < 10,
        `EXT-X-PROGRAM-DATE-TIME is ${driftMinutes.toFixed(1)} minutes from now ` +
          `(${info.firstProgramDateTime}), so it is derived from stream time not wall clock`,
      );
    });
  });
});

/**
 * A cut-down server carrying only the routes under test. Building the real one would
 * require a database, a resolver and a channel config; the routing behaviour that matters
 * here — a master that returns instantly, a media playlist that waits, and ranged
 * segments — is entirely contained in these three handlers.
 */
function buildApp(config: Config, feed: PlaybackSession) {
  const app = Fastify({ logger: false });

  app.get("/ch/:id/live.m3u8", async (_req, reply) => {
    if (!config.hls.masterPlaylist) {
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return readFileSync(feed.playlistPath, "utf8");
    }
    feed.ensureCodecsMeasured();
    const codecs = feed.measuredCodecs ?? computeCodecs({
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      bitrateKbps: parseBitrateKbps(config.video.bitrate),
      profile: config.video.profile,
      level: config.video.level,
    });
    reply.header("Content-Type", "application/vnd.apple.mpegurl");
    return masterPlaylist(codecs, config);
  });

  app.get("/ch/:id/media.m3u8", async (reply) => {
    void reply;
    return readFileSync(feed.playlistPath, "utf8");
  });

  app.get<{ Params: { id: string; segment: string } }>(
    "/ch/:id/:segment",
    async (req, reply) => {
      const path = normalize(join(feed.directory, req.params.segment));
      if (!path.startsWith(feed.directory) || !existsSync(path)) {
        return reply.code(404).send("no such segment");
      }
      const size = statSync(path).size;
      reply.header("Accept-Ranges", "bytes").header("Content-Type", "video/mp2t");

      const range = parseRange(req.headers.range, size);
      if (range === "unsatisfiable") {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send("nope");
      }
      if (range) {
        reply
          .code(206)
          .header("Content-Range", contentRange(range, size))
          .header("Content-Length", rangeLength(range));
        return createReadStream(path, { start: range.start, end: range.end });
      }
      reply.header("Content-Length", size);
      return createReadStream(path);
    },
  );

  return app;
}

describe("playlist delivery", { timeout: 180_000 }, () => {
  it("returns a master fast enough that ExoPlayer will not give up", async () => {
    const config = testConfig(join(root, "latency"));
    const feed = new PlaybackSession("latency", "test", config, provider(60));
    const app = buildApp(config, feed);

    try {
      // Deliberately before any segment exists: this is the cold tune-in that used to
      // hold the response for up to 45 seconds while ffmpeg spun up.
      await feed.ensureStarted();
      const startedAt = Date.now();
      const res = await app.inject({ method: "GET", url: "/ch/latency/live.m3u8" });
      const elapsed = Date.now() - startedAt;

      assert.equal(res.statusCode, 200);
      assert.ok(
        elapsed < 1000,
        `master playlist took ${elapsed}ms on a cold feed; ExoPlayer's data source ` +
          "abandons a request that sends nothing for 8s",
      );
      assert.match(res.body, /^#EXT-X-STREAM-INF:/m);
      assert.ok(res.body.includes('CODECS="avc1.64000c,mp4a.40.2"'), res.body);
      assert.equal(res.headers["content-type"], "application/vnd.apple.mpegurl");
    } finally {
      feed.stop("test complete");
      await sleep(300);
    }
  });

  it("serves ffmpeg's own playlist unchanged at the URI the master points to", async () => {
    const config = testConfig(join(root, "resolve"));
    await withFeed(config, "resolve", async (feed) => {
      const app = buildApp(config, feed);

      const master = await app.inject({ method: "GET", url: "/ch/resolve/live.m3u8" });
      // The master names a bare relative URI, which a client resolves against the
      // master's own path. That is what keeps the segment names inside working.
      const variant = master.body.trim().split("\n").at(-1);
      assert.equal(variant, "media.m3u8");

      const media = await app.inject({ method: "GET", url: `/ch/resolve/${variant}` });
      assert.equal(media.statusCode, 200);
      assert.equal(
        media.body,
        readFileSync(feed.playlistPath, "utf8"),
        "the media playlist was not served byte-for-byte as ffmpeg wrote it",
      );

      // And a segment named inside it resolves and is fetchable.
      const segment = /^seg\d+\.ts$/m.exec(media.body)?.[0];
      assert.ok(segment, `no segment line in:\n${media.body}`);
      const res = await app.inject({ method: "GET", url: `/ch/resolve/${segment}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["accept-ranges"], "bytes");
    });
  });

  it("honours a ranged segment request", async () => {
    const config = testConfig(join(root, "ranged"));
    await withFeed(config, "ranged", async (feed) => {
      const app = buildApp(config, feed);
      const name = feed.newestSegmentPath()!.split("/").at(-1)!;
      const onDisk = readFileSync(feed.newestSegmentPath()!);

      const partial = await app.inject({
        method: "GET",
        url: `/ch/ranged/${name}`,
        headers: { range: "bytes=0-99" },
      });
      assert.equal(partial.statusCode, 206);
      assert.equal(partial.headers["content-range"], `bytes 0-99/${onDisk.length}`);
      assert.equal(partial.headers["content-length"], "100");
      assert.deepEqual(partial.rawPayload, onDisk.subarray(0, 100));

      const past = await app.inject({
        method: "GET",
        url: `/ch/ranged/${name}`,
        headers: { range: `bytes=${onDisk.length}-` },
      });
      assert.equal(past.statusCode, 416);
      assert.equal(past.headers["content-range"], `bytes */${onDisk.length}`);
    });
  });

  it("never lets the media sequence go backwards across a restart", async () => {
    // HLS forbids EXT-X-MEDIA-SEQUENCE from decreasing on a playlist reload. A channel
    // that idles out while a viewer has it paused, then restarts when they resume, used
    // to renumber from zero — which a player reads as the stream having been reset
    // rather than continuing. Desktop tolerates it; ExoPlayer is far less forgiving,
    // and it presents as "it played fine until I paused it".
    const base = testConfig(join(root, "sequence"));
    // A short list, unlike the rest of the suite: the window has to actually slide for
    // EXT-X-MEDIA-SEQUENCE to advance past zero, and a test where it stays at zero would
    // assert 0 >= 0 and pass no matter what the code does.
    const config = testConfig(join(root, "sequence"), { hls: { ...base.hls, listSize: 4 } });
    const dir = join(config.dataDir, "hls", "sequence", "test");

    const first = new PlaybackSession("sequence", "test", config, provider(60));
    await first.ensureStarted();
    // A fixed run, deliberately not "until the sequence reaches N": stopping at the
    // threshold would let the restarted feed clear the same bar within a few seconds and
    // the assertion would hold even when the sequence had reset.
    await sleep(12_000);
    const before = parseMediaPlaylist(readFileSync(first.playlistPath, "utf8"));
    const highestBefore = highestSegment(dir);
    first.stop("idle");
    await sleep(500);

    assert.ok(
      (before.mediaSequence ?? 0) > 0,
      `the window never slid (sequence ${before.mediaSequence}), so this proves nothing`,
    );

    const second = new PlaybackSession("sequence", "test", config, provider(60));
    await second.ensureStarted();
    for (let i = 0; i < 80 && !existsSync(second.playlistPath); i++) await sleep(300);
    await sleep(1500);
    const after = parseMediaPlaylist(readFileSync(second.playlistPath, "utf8"));
    const lowestAfter = lowestSegment(dir);
    second.stop("test complete");
    await sleep(300);

    assert.ok(after.mediaSequence !== null);
    assert.ok(
      after.mediaSequence! >= before.mediaSequence!,
      `media sequence went backwards: ${before.mediaSequence} then ${after.mediaSequence}`,
    );
    // The timing-free form of the same property: the restarted feed's very first segment
    // must be numbered past everything the previous run wrote, no matter how long either
    // ran for.
    assert.ok(
      lowestAfter > highestBefore,
      `restarted feed reused segment numbers: previous run reached ${highestBefore}, ` +
        `new run starts at ${lowestAfter}`,
    );
    // And the playlist names a segment that is really there, so its URIs resolve.
    assert.ok(
      existsSync(join(dir, `seg${String(after.mediaSequence).padStart(6, "0")}.ts`)),
      "the playlist names a segment that is not on disk",
    );
  });

  it("goes back to a bare media playlist when the master is switched off", async () => {
    const base = testConfig(join(root, "killswitch"));
    const config = testConfig(join(root, "killswitch"), {
      hls: { ...base.hls, masterPlaylist: false },
    });
    await withFeed(config, "killswitch", async (feed) => {
      const app = buildApp(config, feed);
      const res = await app.inject({ method: "GET", url: "/ch/killswitch/live.m3u8" });

      // The rollback has to be a real rollback: byte-identical to what ffmpeg wrote, and
      // no trace of a master.
      assert.equal(res.body, readFileSync(feed.playlistPath, "utf8"));
      assert.ok(!res.body.includes("EXT-X-STREAM-INF"), res.body);
    });
  });
});
