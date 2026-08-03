#!/usr/bin/env node
import Fastify, { type FastifyReply } from "fastify";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ChannelService } from "./channels.ts";
import { registerApi } from "./api.ts";
import { registerDebug } from "./debug.ts";
import { contentRange, parseRange, rangeLength } from "./range.ts";
import { warmCapabilities, type PlaybackSession } from "./feed/supervisor.ts";
import { masterPlaylist } from "./feed/playlist.ts";
import { resolveCodecs } from "./debug.ts";
import { baseUrl, loadChannels, loadConfig, type ChannelDef } from "./config.ts";
import { openDb } from "./db.ts";
import {
  buildManifest,
  catalogItemName,
  channelIdFromStremioId,
  stremioId,
} from "./addon/manifest.ts";
import { cooldownRemainingSeconds } from "./content/providers/torbox.ts";
import { logger } from "./log.ts";

const VERSION = "0.1.1";
const log = logger("server");

const config = loadConfig();
let channels = loadChannels(config.channelsFile);
const db = openDb(config.dataDir);
const service = new ChannelService(channels, db, config);

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

/**
 * Applies an edited channel set. The manifest is rebuilt from `channels` on every
 * request, so a reload is picked up by Stremio without restarting the server.
 */
function applyChannels(next: ChannelDef[]): void {
  channels = next;
  const { changed, removed } = service.reload(next);
  for (const id of changed) void service.warmUpChannel(id);
}

// Stremio's web client calls addons from a different origin, so every response needs
// permissive CORS or nothing loads at all.
app.addHook("onSend", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "*");
  reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  // Without this a browser-based player can send a Range request but cannot read the
  // headers describing what came back.
  reply.header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
});
app.options("/*", async (_req, reply) => reply.code(204).send());

// ---------------------------------------------------------------- addon protocol

app.get("/manifest.json", async (_req, reply) => {
  reply.header("Cache-Control", "max-age=3600");
  return buildManifest(channels, VERSION);
});

app.get("/catalog/tv/channels.json", async (_req, reply) => {
  const metas = await Promise.all(
    service.list().map(async (channel) => {
      const view = await service.view(channel.id);
      return {
        id: stremioId(channel.id),
        type: "tv",
        name: catalogItemName(channel.name, view?.nowTitle),
        poster: view?.poster,
        posterShape: "square",
        background: view?.background,
        description: view?.description,
      };
    }),
  );
  // Stremio does not poll an open catalog, but requiring revalidation makes returning
  // to it fetch the current show rather than reuse a stale card label.
  reply.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
  return { metas };
});

app.get<{ Params: { id: string } }>("/meta/tv/:id", async (req, reply) => {
  const channelId = channelIdFromStremioId(decodeURIComponent(req.params.id).replace(/\.json$/, ""));
  if (!channelId) return reply.code(404).send({ err: "not found" });

  const view = await service.view(channelId);
  if (!view) return reply.code(404).send({ err: "no such channel" });

  reply.header("Cache-Control", "max-age=60");
  return {
    meta: {
      id: stremioId(channelId),
      type: "tv",
      name: view.name,
      poster: view.poster,
      posterShape: "square",
      background: view.background,
      description: view.description,
      // Stremio has no EPG fields, so the guide lives in the description.
      releaseInfo: view.nowTitle ?? "Off air",
    },
  };
});

app.get<{ Params: { id: string } }>("/stream/tv/:id", async (req, reply) => {
  const channelId = channelIdFromStremioId(decodeURIComponent(req.params.id).replace(/\.json$/, ""));
  if (!channelId || !service.get(channelId)) {
    return reply.code(404).send({ err: "no such channel" });
  }

  // Stremio requests streams when the channel is opened, a beat before the user presses
  // play. Starting the pipeline now turns a cold start into a warm one and removes most
  // of the wait, since encoders run at real time and cannot be hurried.
  void service.feeds.warm(channelId).catch((err) => log.error(`${channelId}: warm up failed`, err));

  reply.header("Cache-Control", "max-age=10");
  return {
    streams: [
      {
        url: service.streamUrl(channelId),
        name: "Channels",
        description: "Live",
        behaviorHints: {
          // Required: this is HLS, not a plain MP4 the web player can take directly.
          notWebReady: true,
        },
      },
    ],
  };
});

// ---------------------------------------------------------------- the feed

/**
 * Tuning in.
 *
 * This is the URL handed to Stremio, and it answers with a *master* playlist: one
 * variant, carrying the CODECS attribute ExoPlayer wants before it will commit to a
 * stream. Serving it costs nothing and requires no segments to exist yet, so the reply
 * goes out immediately — which matters because ExoPlayer's HTTP data source abandons a
 * request that sends no byte for eight seconds, while a cold pipeline can take longer
 * than that to produce its first segment.
 *
 * The wait therefore lives on `media.m3u8` below, where a 503 can be answered with a
 * Retry-After instead of an unexplained hang.
 */
app.get<{ Params: { channelId: string } }>("/ch/:channelId/live.m3u8", async (req, reply) => {
  const { channelId } = req.params;
  if (!service.get(channelId)) return reply.code(404).send("no such channel");

  // Each tune-in claims its own session, so one viewer pausing cannot freeze another.
  const feed = await service.feeds.claim(channelId);
  if (!config.hls.masterPlaylist) return serveMediaPlaylist(feed, channelId, reply);

  // Kicks off a background reading of what the encoder really emitted; until it lands,
  // the string is derived from config. Never awaited — this reply must not block.
  feed.ensureCodecsMeasured();

  const { advertised } = resolveCodecs(config, feed.measuredCodecs);
  reply
    .header("Content-Type", "application/vnd.apple.mpegurl")
    // Not no-store: the master is stable, but the codec string may be corrected once the
    // first measurement completes, so it must not be cached for long either.
    .header("Cache-Control", "no-cache");
  return masterPlaylist(advertised, config, `s/${feed.sessionId}/media.m3u8`);
});

/**
 * The media playlist ffmpeg actually writes, scoped to one session. Reached from the
 * master's relative URI, so the bare segment names inside it resolve against
 * `/ch/:channelId/s/:sessionId/` without the playlist needing to be rewritten.
 */
app.get<{ Params: { channelId: string; sessionId: string } }>(
  "/ch/:channelId/s/:sessionId/media.m3u8",
  async (req, reply) => {
    const { channelId, sessionId } = req.params;
    const feed = service.feeds.get(sessionId);
    // A session that has been reaped cannot be silently recreated: its segment numbering
    // is gone, so the player must be sent back to the master for a fresh one.
    if (!feed || feed.channelId !== channelId) {
      return reply.code(404).send("no such session");
    }
    return serveMediaPlaylist(feed, channelId, reply);
  },
);

async function serveMediaPlaylist(
  feed: PlaybackSession,
  channelId: string,
  reply: FastifyReply,
): Promise<unknown> {
  // Playlist requests are the only heartbeat a player sends while it is buffering, so
  // they must count against idle shutdown just as segment requests do. They do *not*
  // count as playing: a paused player keeps polling this endpoint indefinitely.
  feed.touch("playlist");
  feed.ensureCodecsMeasured();

  const ready = await waitForPlaylist(feed.playlistPath, config.hls.playlistWaitSeconds * 1000);
  if (!ready) {
    log.error(`${channelId}: playlist never appeared`);
    // Retry-After turns this into an instruction rather than a dead end: a player that
    // gives up on an unexplained 503 will come back for a retry it has been asked to make.
    return reply
      .code(503)
      .header("Retry-After", "2")
      .send("channel is starting, try again in a moment");
  }

  reply
    .header("Content-Type", "application/vnd.apple.mpegurl")
    .header("Cache-Control", "no-cache, no-store");
  return readFileSync(feed.playlistPath, "utf8");
}

app.get<{ Params: { channelId: string; sessionId: string; segment: string } }>(
  "/ch/:channelId/s/:sessionId/:segment",
  async (req, reply) => {
    const { channelId, sessionId, segment } = req.params;
    const feed = service.feeds.get(sessionId);
    if (!feed || feed.channelId !== channelId) return reply.code(404).send("no such session");

    // Every segment request is a heartbeat; without them the feed shuts itself down.
    // Unlike a playlist poll, this also proves the viewer is actually playing.
    feed.touch("segment");
    // Also the most reliable moment to measure the codec string: a segment request proves
    // segments exist, whereas the first playlist requests arrive before the encoder has
    // produced anything to read. Cheap — it does nothing once a measurement has landed.
    feed.ensureCodecsMeasured();

    if (!/^seg\d+\.ts$/.test(segment)) return reply.code(400).send("bad segment");
    const path = normalize(join(feed.directory, segment));
    if (!path.startsWith(feed.directory) || !existsSync(path)) {
      return reply.code(404).send("no such segment");
    }

    const size = statSync(path).size;
    reply
      .header("Content-Type", "video/mp2t")
      // Advertised unconditionally: without it a player will not attempt a ranged retry
      // even when the server would honour one.
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "max-age=60");

    // ExoPlayer retries a failed segment with a Range header. Answering that with a full
    // 200 makes it re-download from the start, so honour it properly.
    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      return reply
        .code(416)
        .header("Content-Range", `bytes */${size}`)
        .send("range not satisfiable");
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

// ---------------------------------------------------------------- config UI

registerApi(app, service, db, config, applyChannels);
registerDebug(app, service, config);

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "ui");

app.get("/", async (_req, reply) => reply.redirect("/ui"));

app.get("/ui", async (_req, reply) => {
  reply.header("Content-Type", "text/html; charset=utf-8");
  return createReadStream(join(uiDir, "index.html"));
});

/**
 * Chrome cannot play HLS natively, so the preview player needs hls.js. It is served from
 * node_modules rather than a CDN so the UI keeps working on a machine with no internet
 * access to anything but the debrid service.
 */
app.get("/ui/hls.js", async (_req, reply) => {
  const candidates = [
    join(process.cwd(), "node_modules/hls.js/dist/hls.min.js"),
    join(uiDir, "..", "..", "node_modules/hls.js/dist/hls.min.js"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) return reply.code(404).send("hls.js not installed");

  reply.header("Content-Type", "text/javascript").header("Cache-Control", "max-age=86400");
  return createReadStream(found);
});

// ---------------------------------------------------------------- diagnostics

app.get("/health", async () => {
  const cooldown = cooldownRemainingSeconds();
  return {
    ok: true,
    version: VERSION,
    // Surfaced because a rate limited debrid account looks exactly like a broken
    // scheduler from the outside: channels simply stop gaining programs.
    ...(cooldown > 0 ? { debridCooldownSeconds: cooldown } : {}),
    channels: service.list().map((c) => ({
      id: c.id,
      name: c.name,
      live: service.feeds.isChannelLive(c.id),
      scheduledThrough: db.timelineEnd(c.id).endMs
        ? new Date(db.timelineEnd(c.id).endMs!).toISOString()
        : null,
    })),
  };
});

app.get("/guide", async (_req, reply) => {
  const views = await Promise.all(service.list().map((c) => service.view(c.id)));
  reply.header("Content-Type", "text/plain; charset=utf-8");
  return views
    .filter((v) => v !== null)
    .map((v) => `${v.name}\n${v.description}`)
    .join("\n\n");
});

// ---------------------------------------------------------------- lifecycle

async function waitForPlaylist(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      // The file exists as soon as the first segment lands, but players stall on a
      // playlist with only one entry. Wait for a small buffer to accumulate.
      const segments = readFileSync(path, "utf8").match(/^seg\d+\.ts$/gm)?.length ?? 0;
      if (segments >= 2) return true;
    }
    await sleep(250);
  }
  return existsSync(path);
}

function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  service.feeds.stopAll("server shutdown");
  app.close().finally(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  log.info(`listening on ${baseUrl(config)}`);
  log.info(`install this addon in Stremio:  ${baseUrl(config)}/manifest.json`);
  log.info(`channels: ${channels.map((c) => c.id).join(", ")}`);

  // Probe ffmpeg up front so the first viewer does not pay for a test encode, then build
  // the timelines in the background so the first tune-in is not also the first time we
  // talk to Cinemeta and the debrid service.
  void warmCapabilities(config).catch((err) => log.warn("capability probe failed", err));
  void service
    .verifyResolver()
    .then(() => {
      service.startScheduleKeeper();
      service.startLinkKeeper();
      return service.warmUp();
    })
    .catch((err) => log.error("background startup failed", err));
} catch (err) {
  log.error("failed to start", err);
  process.exit(1);
}
