import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Fastify from "fastify";
import { registerApi } from "./api.ts";
import { ChannelService } from "./channels.ts";
import { writeChannelsFile } from "./channels-file.ts";
import { channelSchema, type ChannelDef } from "./config.ts";
import { openDb } from "./db.ts";
import { testConfig } from "./testing/harness.ts";

const root = mkdtempSync(join(tmpdir(), "channels-api-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function channel(id: string, imdb = "tt5000001"): ChannelDef {
  return channelSchema.parse({
    id,
    name: `Custom ${id}`,
    strategy: "shuffle",
    seed: 42,
    content: [{ type: "movie", id: imdb }],
  });
}

function makeApp(name: string, initial: ChannelDef[]) {
  const dataDir = join(root, name);
  const config = testConfig(dataDir);
  const db = openDb(dataDir);
  writeChannelsFile(config.channelsFile, initial);
  const service = new ChannelService(initial, db, config);
  const app = Fastify();
  registerApi(app, service, db, config, (next) => service.reload(next));
  return { app, config, db, service };
}

describe("channel API", () => {
  it("publishes a bounded, read-only guide for the standalone viewer", async () => {
    const configured = channelSchema.parse({
      ...channel("viewer"),
      name: "Viewer Channel",
      poster: "https://images.example/channel.jpg",
      description: "A private channel",
    });
    const ctx = makeApp("viewer-guide", [configured]);
    const now = Date.now();
    ctx.db.putCached("cinemeta:movie:tt5000001", {
      id: "tt5000001",
      name: "Viewer Movie",
      runtime: "60 min",
      poster: "https://images.example/program.jpg",
      background: "https://images.example/background.jpg",
    });
    ctx.db.insertPrograms([{
      channel_id: "viewer",
      slot_index: 0,
      start_ms: now - 60_000,
      duration_ms: 3_600_000,
      ref_key: "tt5000001",
      title: "Viewer Movie",
      resolved_url: "https://secret.example/debrid-token",
      url_expires_at: now + 3_600_000,
      daypart: "Prime time",
      torrent_id: 123,
      file_id: 456,
    }]);
    ctx.db.putProbe({
      ref_key: "tt5000001",
      duration_ms: 3_600_000,
      video_codec: "h264",
      audio_codec: "aac",
      probed_at: now,
    });

    const response = await ctx.app.inject({ method: "GET", url: "/viewer/guide.json?hours=99" });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.until - body.serverTime, 12 * 3_600_000);
    assert.equal(body.channels[0].id, "viewer");
    assert.equal(body.channels[0].poster, "https://images.example/channel.jpg");
    assert.equal(body.channels[0].description, "A private channel");
    assert.deepEqual(body.channels[0].programs[0], {
      title: "Viewer Movie",
      start: now - 60_000,
      duration: 3_600_000,
      daypart: "Prime time",
      isNow: true,
    });
    assert.doesNotMatch(response.body, /debrid-token|resolved_url|torrent_id|file_id/);

    const tune = await ctx.app.inject({ method: "GET", url: "/viewer/tune/viewer" });
    assert.equal(tune.statusCode, 200, tune.body);
    assert.equal(tune.headers["cache-control"], "no-store");
    assert.equal(tune.json().playback.mode, "direct");
    assert.equal(tune.json().playback.directUrl, "https://secret.example/debrid-token");
    assert.ok(tune.json().playback.offsetMs >= 60_000);
    assert.equal(tune.json().playback.hlsPath, "ch/viewer/live.m3u8");
    assert.doesNotMatch(tune.body, /torrent_id|file_id|123|456/);

    ctx.db.putProbe({
      ref_key: "tt5000001",
      duration_ms: 3_600_000,
      video_codec: "mpeg2video",
      audio_codec: "aac",
      probed_at: now,
    });
    const fallback = await ctx.app.inject({ method: "GET", url: "/viewer/tune/viewer" });
    assert.equal(fallback.json().playback.mode, "hls");
    assert.equal(fallback.json().playback.reason, "unsupported-codecs");
    assert.equal(fallback.json().playback.directUrl, undefined);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });

  it("refuses a colliding preset unless replacement is explicit", async () => {
    const ctx = makeApp("preset-conflict", [channel("scifi")]);
    const before = readFileSync(ctx.config.channelsFile, "utf8");

    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/api/presets/apply",
      payload: { key: "scifi-channel", mode: "add" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().existingChannelId, "scifi");
    assert.equal(readFileSync(ctx.config.channelsFile, "utf8"), before);

    const replaced = await ctx.app.inject({
      method: "POST",
      url: "/api/presets/apply",
      payload: { key: "scifi-channel", mode: "replace" },
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().action, "replaced");
    assert.equal(ctx.service.list().length, 1);
    assert.equal(ctx.service.get("scifi")?.name, "Sci-Fi Channel");
    assert.equal(ctx.service.get("scifi")?.dayparts.length, 3);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });

  it("adds a non-conflicting preset without renaming it", async () => {
    const ctx = makeApp("preset-add", [channel("scifi")]);
    const added = await ctx.app.inject({
      method: "POST",
      url: "/api/presets/apply",
      payload: { key: "adult-swim", mode: "add" },
    });

    assert.equal(added.statusCode, 200);
    assert.equal(added.json().action, "added");
    assert.deepEqual(ctx.service.list().map((item) => item.id), ["scifi", "adultswim"]);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });

  it("previews an unsaved channel without changing channels, counters or schedules", async () => {
    const ctx = makeApp("preview", [channel("existing")]);
    const imdb = "tt5000099";
    ctx.db.putCached(`cinemeta:movie:${imdb}`, {
      id: imdb,
      name: "Preview Movie",
      runtime: "90 min",
    });
    ctx.db.nextCounter("draft", "slot:default");
    const before = readFileSync(ctx.config.channelsFile, "utf8");

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/channels/preview",
      payload: {
        hours: 3,
        channel: channel("draft", imdb),
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.contentCount, 1);
    assert.equal(body.programs.length, 2);
    assert.equal(body.programs[0].title, "Preview Movie");
    assert.equal(body.programs[0].durationSource, "estimated");
    assert.equal(readFileSync(ctx.config.channelsFile, "utf8"), before);
    assert.equal(ctx.db.counter("draft", "slot:default"), 1);
    assert.equal(ctx.db.programsFrom("draft", 0, 10).length, 0);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });

  it("previews combined named pools without saving the canonical draft", async () => {
    const ctx = makeApp("pool-preview", [channel("existing-pools")]);
    for (const [id, name, runtime] of [
      ["tt5000101", "Pool Movie", "90 min"],
      ["tt5000102", "Second Pool Movie", "80 min"],
    ] as const) {
      ctx.db.putCached(`cinemeta:movie:${id}`, { id, name, runtime });
    }
    const before = readFileSync(ctx.config.channelsFile, "utf8");
    const draft = channelSchema.parse({
      id: "combined",
      name: "Combined Pools",
      strategy: "sequential",
      pools: [
        { id: "one", name: "One", content: [{ type: "movie", id: "tt5000101" }] },
        { id: "two", name: "Two", content: [{ type: "movie", id: "tt5000102" }] },
      ],
      defaultPoolIds: ["one", "two"],
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/channels/preview",
      payload: { hours: 4, channel: draft },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().contentCount, 2);
    assert.deepEqual(
      new Set(response.json().programs.map((program: { title: string }) => program.title)),
      new Set(["Pool Movie", "Second Pool Movie"]),
    );
    assert.equal(readFileSync(ctx.config.channelsFile, "utf8"), before);
    assert.equal(ctx.db.programsFrom("combined", 0, 10).length, 0);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });

  it("validates similar-content requests and reports missing TMDB setup without writing", async () => {
    const ctx = makeApp("similar-metadata", [channel("existing-similar")]);
    const before = readFileSync(ctx.config.channelsFile, "utf8");

    const invalid = await ctx.app.inject({
      method: "GET",
      url: "/api/metadata/similar?type=video&id=not-imdb",
    });
    assert.equal(invalid.statusCode, 400);

    const unconfigured = await ctx.app.inject({
      method: "GET",
      url: "/api/metadata/similar?type=movie&id=tt0083658",
    });
    assert.equal(unconfigured.statusCode, 400);
    assert.match(unconfigured.json().missing, /tmdb/);
    assert.equal(readFileSync(ctx.config.channelsFile, "utf8"), before);

    await ctx.app.close();
    ctx.service.feeds.stopAll("test complete");
    ctx.db.close();
  });
});
