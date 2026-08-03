/**
 * Diagnostics for the one thing that cannot be tested from here: whether a real Android
 * TV or Fire TV can play a channel.
 *
 * The user has no ADB access, so the player's own error messages are out of reach and the
 * server has to be able to explain the failure by itself. That is what `recentRequests`
 * is for — knowing whether the device reached the server at all, how far through the HLS
 * handshake it got, and what it asked for, separates four completely different faults
 * that otherwise all present as "it doesn't play".
 *
 * Everything here is read-only and additive. It is deliberately one file so it can be
 * deleted wholesale once Android playback is settled.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { promisify } from "node:util";
import type { ChannelService } from "./channels.ts";
import { baseUrl, type Config } from "./config.ts";
import {
  computeCodecs,
  parseBitrateKbps,
  probeSegment,
  type CodecString,
} from "./feed/codecs.ts";
import { masterPlaylist, parseMediaPlaylist } from "./feed/playlist.ts";
import { detectEncoder } from "./feed/hwaccel.ts";

const exec = promisify(execFile);

/** Enough history to cover a device's whole attempt without growing without bound. */
const RING_SIZE = 64;

interface RequestRecord {
  at: string;
  path: string;
  status: number;
  /** The Range header, when the client sent one. ExoPlayer uses these on retries. */
  range: string | null;
  userAgent: string | null;
  bytes: number | null;
}

const recent: RequestRecord[] = [];

function record(entry: RequestRecord): void {
  recent.unshift(entry);
  if (recent.length > RING_SIZE) recent.length = RING_SIZE;
}

let ffmpegVersionCache: string | null | undefined;

async function ffmpegVersion(): Promise<string | null> {
  if (ffmpegVersionCache !== undefined) return ffmpegVersionCache;
  try {
    const { stdout } = await exec("ffmpeg", ["-version"], { timeout: 10_000 });
    ffmpegVersionCache = /^ffmpeg version (\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    ffmpegVersionCache = null;
  }
  return ffmpegVersionCache;
}

/** Codec settings as the encoder is configured, ready for `computeCodecs`. */
export function codecOptionsFrom(config: Config) {
  return {
    width: config.video.width,
    height: config.video.height,
    fps: config.video.fps,
    bitrateKbps: parseBitrateKbps(config.video.bitrate),
    profile: config.video.profile,
    level: config.video.level,
  };
}

export type CodecSource = "config-override" | "measured" | "computed";

/**
 * Which codec string to advertise, and why.
 *
 * Measurement beats computation because it describes the bytes that actually went out.
 * Computation exists for the cold-start case, where the master playlist has to be served
 * before any segment exists to measure.
 */
export function resolveCodecs(
  config: Config,
  measured: CodecString | null,
): { advertised: CodecString; source: CodecSource; computed: CodecString } {
  const computed = computeCodecs(codecOptionsFrom(config));

  if (config.hls.codecs) {
    const combined = config.hls.codecs;
    const [video = combined, audio = ""] = combined.split(",");
    return {
      advertised: { video, audio, combined },
      source: "config-override",
      computed,
    };
  }
  if (measured) return { advertised: measured, source: "measured", computed };
  return { advertised: computed, source: "computed", computed };
}

export function registerDebug(
  app: FastifyInstance,
  service: ChannelService,
  config: Config,
): void {
  // Every feed request, regardless of outcome. Registered here rather than in server.ts
  // so the diagnostic code stays in one place.
  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/ch/")) return;
    const length = reply.getHeader("content-length");
    record({
      at: new Date().toISOString(),
      path: req.url,
      status: reply.statusCode,
      range: (req.headers.range as string | undefined) ?? null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      bytes: length === undefined ? null : Number(length),
    });
  });

  app.get<{ Params: { channelId: string } }>("/debug/hls/:channelId", async (req, reply) => {
    const { channelId } = req.params;
    if (!service.get(channelId)) return reply.code(404).send({ error: "no such channel" });
    return describeChannel(service, config, channelId);
  });

  /** Every channel in one request, so a report is a single curl. */
  app.get("/debug/hls", async () => {
    const channels = await Promise.all(
      service.list().map((channel) => describeChannel(service, config, channel.id)),
    );
    return { channels, recentRequests: recent };
  });
}

async function describeChannel(service: ChannelService, config: Config, channelId: string) {
  const sessions = service.feeds.forChannel(channelId);
  // Top-level fields describe the most recently active session, which is what a single
  // viewer reporting a problem is almost always looking at. `sessions` below carries the
  // rest, since a channel may now have several.
  const feed = [...sessions].sort((a, b) => a.idleSeconds - b.idleSeconds)[0];
  const base = baseUrl(config);
  const { advertised, source, computed } = resolveCodecs(config, feed?.measuredCodecs ?? null);

  const segment = feed?.newestSegmentPath() ?? null;
  const [probed, ffmpeg] = await Promise.all([
    segment ? probeSegment(segment) : Promise.resolve(null),
    ffmpegVersion(),
  ]);

  const mediaText =
    feed && existsSync(feed.playlistPath) ? readFileSync(feed.playlistPath, "utf8") : null;

  const measured = feed?.measuredCodecs ?? null;

  return {
    channelId,
    running: feed?.isRunning ?? false,
    encoder: feed?.encoderKind ?? (await detectEncoder(config)),
    ffmpegVersion: ffmpeg,

    sessionId: feed?.sessionId ?? null,
    // One entry per viewer. Two sessions drifting apart is expected once someone pauses;
    // that is the feature, not a fault.
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      running: s.isRunning,
      claimed: s.isClaimed,
      // paused means the encoder is suspended, so the segment count on disk should be
      // holding still; driftSeconds is how far behind live that has left this viewer.
      paused: s.isPaused,
      driftSeconds: Math.round(s.driftSeconds),
      idleSeconds: Math.round(s.idleSeconds),
      secondsSinceSegment: Math.round(s.secondsSinceSegment),
    })),

    // The single most common reason a TV cannot play anything: the URL baked into the
    // stream response points at the server's own loopback address.
    publicBaseUrl: base,
    publicBaseUrlExplicit: Boolean(config.publicBaseUrl),
    publicBaseUrlIsLoopback: /^https?:\/\/(127\.|localhost|\[::1\])/i.test(base),

    // Exactly what Stremio is handed, so a mismatch with the above is obvious.
    stream: {
      url: service.streamUrl(channelId),
      name: "Channels",
      description: "Live",
      behaviorHints: { notWebReady: true },
    },

    advertised: { ...advertised, source },
    computed,
    measured,
    // If this is false the stream is being described to the player as something it is
    // not, which is a server bug and worth fixing before blaming the device.
    codecsAgree: measured === null || measured.combined === computed.combined,

    probed,
    probedSegment: segment ? segment.split("/").at(-1) : null,

    config: {
      masterPlaylist: config.hls.masterPlaylist,
      programDateTime: config.hls.programDateTime,
      codecsOverride: config.hls.codecs ?? null,
      playlistWaitSeconds: config.hls.playlistWaitSeconds,
      segmentSeconds: config.hls.segmentSeconds,
      listSize: config.hls.listSize,
      pauseDetectSeconds: config.hls.pauseDetectSeconds,
      maxSessions: config.maxSessions,
      profile: config.video.profile,
      level: config.video.level,
      resolution: `${config.video.width}x${config.video.height}`,
      fps: config.video.fps,
      bitrate: config.video.bitrate,
    },

    // Rendered with the live session's URI where there is one, so this is byte-for-byte
    // what the player was actually handed rather than an idealised version of it.
    master: masterPlaylist(
      advertised,
      config,
      feed ? `s/${feed.sessionId}/media.m3u8` : undefined,
    ),
    media: mediaText,
    mediaInfo: mediaText ? parseMediaPlaylist(mediaText) : null,

    recentRequests: recent.filter((r) => r.path.startsWith(`/ch/${channelId}/`)),
  };
}
