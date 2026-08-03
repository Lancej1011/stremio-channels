import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/** A single scheduleable unit of content. Series entries expand into one ref per episode. */
export const contentRefSchema = z.object({
  type: z.enum(["movie", "series"]),
  /** IMDb id, e.g. tt3230854. For episodes this is the *series* id. */
  id: z.string().regex(/^tt\d+$/, "must be an IMDb id like tt3230854"),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
  /**
   * Relative airtime share within its pool. A weight of 2 means this entry comes up
   * twice as often as a weight of 1. Only used by the weighted strategy.
   */
  weight: z.number().positive().max(100).optional(),
});

export type ContentRef = z.infer<typeof contentRefSchema>;

/** Stable string form used as a database key and for airing history. */
export function refKey(ref: ContentRef): string {
  return ref.season !== undefined && ref.episode !== undefined
    ? `${ref.id}:${ref.season}:${ref.episode}`
    : ref.id;
}

export function parseRefKey(key: string): ContentRef {
  const [id, season, episode] = key.split(":");
  if (!id) throw new Error(`malformed ref key: ${key}`);
  return season !== undefined && episode !== undefined
    ? { type: "series", id, season: Number(season), episode: Number(episode) }
    : { type: "movie", id };
}

export const strategySchema = z.enum(["shuffle", "sequential", "weighted"]);
export type StrategyName = z.infer<typeof strategySchema>;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9-]*$/;
export const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof weekdaySchema>;

/**
 * A block of the day with its own programming. Ranges may cross midnight
 * (`"23:00"` to `"02:00"`), which is where most of the interesting scheduling lives.
 */
export const daypartSchema = z.object({
  name: z.string().min(1),
  start: z.string().regex(TIME_OF_DAY, "must be HH:MM, 24 hour"),
  end: z.string().regex(TIME_OF_DAY, "must be HH:MM, 24 hour"),
  /** Omit for every day. Overnight blocks are anchored to the day they start. */
  days: z.array(weekdaySchema).min(1).optional(),
  strategy: strategySchema.optional(),
  /** Omit to keep the channel's own content and only change strategy for these hours. */
  content: z.array(contentRefSchema).min(1).optional(),
  /** Canonical creator model: one or more named pools, merged in this order. */
  poolIds: z.array(z.string().regex(LOCAL_ID)).min(1).optional(),
}).refine((block) => !(block.content && block.poolIds), {
  message: "a block cannot use both legacy content and named pools",
  path: ["poolIds"],
});

export type DaypartDef = z.infer<typeof daypartSchema>;

/**
 * Where a channel's content comes from when it is not hand-picked.
 *
 * `rule` needs no credentials at all, which is what makes smart channels usable by
 * anyone who installs this. The import kinds need a key and stay optional.
 */
export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    type: z.enum(["movie", "series"]).default("movie"),
    genres: z.array(z.string()).default([]),
    /** Inclusive [from, to] release-year range. */
    years: z.tuple([z.number().int(), z.number().int()]).optional(),
    minRating: z.number().min(0).max(10).optional(),
    limit: z.number().int().positive().max(500).default(50),
  }),
  z.object({
    kind: z.literal("mdblist"),
    /** Full list URL, e.g. https://mdblist.com/lists/user/list-name */
    url: z.string().min(1),
    limit: z.number().int().positive().max(500).default(100),
  }),
  z.object({
    kind: z.literal("trakt"),
    url: z.string().min(1),
    limit: z.number().int().positive().max(500).default(100),
  }),
  z.object({
    kind: z.literal("stremio"),
    /** Which part of the library to draw on. */
    include: z.enum(["library", "watchlist", "all"]).default("all"),
    limit: z.number().int().positive().max(500).default(100),
  }),
  z.object({
    kind: z.literal("tmdb"),
    type: z.enum(["movie", "series"]),
    includeGenres: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    excludeGenres: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    years: z.tuple([z.number().int().min(1870), z.number().int().max(2200)]).optional(),
    minRating: z.number().min(0).max(10).optional(),
    minVotes: z.number().int().nonnegative().optional(),
    runtime: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    languages: z.array(z.string().min(2).max(8)).default([]),
    countries: z.array(z.string().length(2)).default([]),
    companies: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    networks: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    includeKeywords: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    excludeKeywords: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })).default([]),
    sort: z.enum(["popularity", "rating", "newest"]).default("popularity"),
    limit: z.number().int().positive().max(500).default(50),
  }),
]).superRefine((source, ctx) => {
  if (source.kind === "tmdb") {
    if (source.years && source.years[0] > source.years[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "year start must not exceed end", path: ["years"] });
    }
    if (source.runtime && source.runtime[0] > source.runtime[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "runtime minimum must not exceed maximum", path: ["runtime"] });
    }
    if (source.type === "movie" && source.networks.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "networks apply only to series", path: ["networks"] });
    }
  }
});

export type SourceDef = z.infer<typeof sourceSchema>;

const excludedTitleSchema = z.object({
  type: z.enum(["movie", "series"]),
  id: z.string().regex(/^tt\d+$/, "must be an IMDb id like tt3230854"),
});

export const contentPoolSchema = z.object({
  id: z.string().regex(LOCAL_ID, "lowercase letters, digits and dashes only"),
  name: z.string().min(1),
  /** Explicit titles are pins and remain even when a live source changes. */
  content: z.array(contentRefSchema).default([]),
  source: sourceSchema.optional(),
  /** Applies to source matches only; explicitly pinned content always wins. */
  excluded: z.array(excludedTitleSchema).default([]),
  refreshHours: z.number().positive().default(168),
}).refine((pool) => pool.content.length > 0 || pool.source !== undefined, {
  message: "a pool needs pinned content or an automatic source",
  path: ["content"],
});

export type ContentPoolDef = z.infer<typeof contentPoolSchema>;

export const channelSchema = z.object({
  id: z
    .string()
    .regex(LOCAL_ID, "lowercase letters, digits and dashes only"),
  name: z.string().min(1),
  poster: z.string().url().optional(),
  description: z.string().optional(),
  strategy: strategySchema.default("shuffle"),
  /** Fixes the deterministic schedule. Change it to reshuffle the channel. */
  seed: z.number().int().default(1),
  /** Hand-picked titles. May be empty when `source` populates the channel instead. */
  content: z.array(contentRefSchema).default([]),
  /** Auto-populates the channel. Anything in `content` is kept and added to. */
  source: sourceSchema.optional(),
  /** How long a source's result is reused before being fetched again. */
  refreshHours: z.number().positive().default(168),
  /** Canonical creator model. Legacy content/source remain supported when this is empty. */
  pools: z.array(contentPoolSchema).default([]),
  defaultPoolIds: z.array(z.string().regex(LOCAL_ID)).default([]),
  /** Optional overrides for parts of the day. Uncovered hours use the channel default. */
  dayparts: z.array(daypartSchema).default([]),
}).superRefine((channel, ctx) => {
  const usingPools = channel.pools.length > 0;
  const usingLegacy = channel.content.length > 0 || channel.source !== undefined;

  if (!usingPools && !usingLegacy) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a channel needs content, a source, or named pools", path: ["content"] });
  }
  if (usingPools && usingLegacy) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "named pools cannot be combined with legacy channel content/source", path: ["pools"] });
  }
  if (usingPools && channel.defaultPoolIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "named-pool channels need at least one default pool", path: ["defaultPoolIds"] });
  }
  if (!usingPools && channel.defaultPoolIds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "defaultPoolIds requires named pools", path: ["defaultPoolIds"] });
  }

  const ids = new Set<string>();
  for (const [index, pool] of channel.pools.entries()) {
    if (ids.has(pool.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate pool id: ${pool.id}`, path: ["pools", index, "id"] });
    }
    ids.add(pool.id);
    const pinned = new Set(pool.content.map((entry) => `${entry.type}:${entry.id}`));
    const conflict = pool.excluded.find((entry) => pinned.has(`${entry.type}:${entry.id}`));
    if (conflict) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${conflict.id} cannot be pinned and excluded`, path: ["pools", index, "excluded"] });
    }
  }
  for (const [index, id] of channel.defaultPoolIds.entries()) {
    if (!ids.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown pool: ${id}`, path: ["defaultPoolIds", index] });
  }
  for (const [blockIndex, block] of channel.dayparts.entries()) {
    for (const [poolIndex, id] of (block.poolIds ?? []).entries()) {
      if (!ids.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown pool: ${id}`, path: ["dayparts", blockIndex, "poolIds", poolIndex] });
    }
    if (block.poolIds && !usingPools) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "block poolIds requires named pools", path: ["dayparts", blockIndex, "poolIds"] });
    }
  }
});

export type ChannelDef = z.infer<typeof channelSchema>;

export const channelsFileSchema = z.object({
  channels: z.array(channelSchema).min(1),
});

/**
 * A boolean that also accepts the strings an environment variable can carry.
 * `z.coerce.boolean()` is unusable here: it would read "false" as true, since any
 * non-empty string is truthy.
 */
function booleanish(defaultValue: boolean) {
  return z
    .preprocess(
      (value) => (typeof value === "string" ? /^(1|true|yes|on)$/i.test(value) : value),
      z.boolean(),
    )
    .default(defaultValue);
}

/** Optional config placeholders are commonly left as empty strings in JSON/env files. */
function optionalString() {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().optional(),
  );
}

function optionalUrl() {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  );
}

const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(7654),
  /**
   * Base URL Stremio will use to reach this server. Must be reachable from the client,
   * so it cannot stay on localhost once you watch from another device.
   */
  publicBaseUrl: optionalUrl(),
  dataDir: z.string().default("./data"),
  channelsFile: z.string().default("./channels.json"),

  /**
   * A Stremio stream addon already configured with your debrid key
   * (Torrentio / Comet / MediaFusion). Its /stream responses are our source of
   * seekable HTTPS URLs, which is why Phase 1 needs no TorBox code of its own.
   */
  streamAddonUrl: optionalUrl(),

  /**
   * TorBox API key. When set, programs resolve through TorBox directly and
   * `indexerUrl` supplies the torrent hashes, since TorBox has no search of its own.
   * This gives real control over which release airs. Without it, `streamAddonUrl` is
   * used instead.
   */
  torboxApiKey: optionalString(),
  /**
   * A Stremio indexer addon used *without* a debrid key, so it returns raw infoHashes.
   * Plain Torrentio works and needs no configuration.
   */
  indexerUrl: z.string().url().default("https://torrentio.strem.fun"),

  /**
   * Optional credentials for smart-channel import sources. Rule-based channels need
   * none of these; each import kind stays hidden in the UI until its key is present.
   */
  mdblistApiKey: optionalString(),
  traktClientId: optionalString(),
  /** TMDB v4 bearer token (preferred) or the legacy v3 API key below. */
  tmdbReadAccessToken: optionalString(),
  tmdbApiKey: optionalString(),
  /** A Stremio auth key, obtained by the user. Never a password. */
  stremioAuthKey: optionalString(),

  /** Preferred resolutions, best first. */
  qualityPreference: z.array(z.string()).default(["1080p", "720p", "2160p", "480p"]),
  /** Skip releases bigger than this. Remuxes gain nothing once re-encoded. */
  maxSizeGb: z.number().optional().default(25),

  video: z
    .object({
      width: z.number().int().default(1920),
      height: z.number().int().default(1080),
      fps: z.number().int().default(30),
      bitrate: z.string().default("6000k"),
      /** Segment boundaries land on these keyframes, so it must divide hlsSegmentSeconds. */
      gopSeconds: z.number().default(2),
      /**
       * H.264 profile. `main` exists as a fallback for players that reject High; no
       * `baseline`, because VAAPI spells it `constrained_baseline` and the value would
       * not be portable across encoders.
       */
      profile: z.enum(["high", "main"]).default("high"),
      /**
       * H.264 level. `auto` lets the encoder choose, which is the safe value — a pinned
       * level a hardware encoder cannot satisfy makes it refuse to open at all. Only pin
       * one when a specific player is known to need it.
       */
      level: z.string().default("auto"),
    })
    .default({}),

  audio: z
    .object({
      bitrate: z.string().default("128k"),
      sampleRate: z.number().int().default(48000),
      channels: z.number().int().default(2),
    })
    .default({}),

  hls: z
    .object({
      // Encoders run at real time, so a player cannot start until segmentSeconds x2
      // have actually elapsed. Short segments are what keep tune-in quick.
      segmentSeconds: z.number().default(2),
      listSize: z.number().int().default(12),
      /**
       * Serve a master playlist carrying a CODECS attribute rather than handing the
       * player a bare media playlist. Android clients want this; set false to go back to
       * exactly the pre-Phase-3 behaviour.
       */
      masterPlaylist: booleanish(true),
      /** Adds EXT-X-PROGRAM-DATE-TIME. Off by default; it interacts with -copyts. */
      programDateTime: booleanish(false),
      /**
       * Overrides the advertised CODECS string outright. An escape hatch for trying a
       * value against a real device without a rebuild; normally the served string is
       * measured from the stream itself.
       */
      codecs: z.string().optional(),
      /**
       * How long a media playlist request waits for the pipeline to produce segments.
       * ExoPlayer's HTTP data source gives up after 8s of silence, so a long wait reads
       * as a failure on Android even though desktop would have waited happily.
       */
      playlistWaitSeconds: z.coerce.number().int().positive().default(20),
      /**
       * How long without a segment request counts as paused, while the player is still
       * polling the playlist. Four segment intervals by default — clear of ordinary
       * network jitter, short enough that the encoder is not left running for long after
       * the viewer stops watching.
       */
      pauseDetectSeconds: z.coerce.number().positive().default(8),
    })
    .default({}),

  /** Tear the pipeline down this long after the last request of any kind. */
  idleShutdownSeconds: z.number().int().default(120),
  /**
   * Concurrent playback sessions, each holding one hardware encoder session. GPUs cap
   * how many may exist at once (8 on current NVENC), so this stays below that and the
   * least recently used session is evicted rather than failing the new viewer.
   */
  maxSessions: z.coerce.number().int().positive().default(6),
  /** How far ahead the scheduler keeps the timeline filled. */
  scheduleHorizonHours: z.number().default(24),
  /**
   * Which channels the link keeper tops up ahead of time. Debrid links are short lived,
   * so keeping every channel ready costs a steady stream of API calls for channels nobody
   * watches. `watched` limits that to channels currently playing or watched recently;
   * `all` restores the original behaviour of preparing every channel.
   */
  linkKeeperScope: z.enum(["watched", "all"]).default("watched"),
  /**
   * How long a channel stays "recently watched" after its last program boundary. Covers
   * channel surfing and coming straight back, so a regular does not go cold between
   * viewings. Only meaningful when `linkKeeperScope` is `watched`.
   */
  linkKeeperGraceMinutes: z.coerce.number().nonnegative().default(30),
  /** Force an encoder to `hwaccel` value: auto | nvenc | qsv | vaapi | cpu. */
  encoder: z.enum(["auto", "nvenc", "qsv", "vaapi", "cpu"]).default("auto"),
});

export type Config = z.infer<typeof configSchema> & {
  dataDir: string;
  channelsFile: string;
};

function fromEnv(): Record<string, unknown> {
  const e = process.env;
  const raw: Record<string, unknown> = {
    host: e.HOST,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    dataDir: e.DATA_DIR,
    channelsFile: e.CHANNELS_FILE,
    streamAddonUrl: e.STREAM_ADDON_URL,
    torboxApiKey: e.TORBOX_API_KEY,
    indexerUrl: e.INDEXER_URL,
    mdblistApiKey: e.MDBLIST_API_KEY,
    traktClientId: e.TRAKT_CLIENT_ID,
    stremioAuthKey: e.STREMIO_AUTH_KEY,
    tmdbReadAccessToken: e.TMDB_API_TOKEN,
    tmdbApiKey: e.TMDB_API_KEY,
    encoder: e.ENCODER,
  };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  return raw;
}

/**
 * Environment overrides that live inside a nested block.
 *
 * These are kept apart from `fromEnv` because the top-level merge is a shallow spread: a
 * `video` object built here and spread in directly would replace the file's whole `video`
 * block, silently resetting bitrate, resolution and frame rate to their defaults for
 * anyone who set one of these variables.
 */
function nestedFromEnv(): Record<string, Record<string, unknown>> {
  const e = process.env;
  const blocks: Record<string, Record<string, unknown>> = {
    video: { profile: e.VIDEO_PROFILE, level: e.VIDEO_LEVEL },
    hls: {
      masterPlaylist: e.HLS_MASTER_PLAYLIST,
      programDateTime: e.HLS_PROGRAM_DATE_TIME,
      codecs: e.HLS_CODECS,
      playlistWaitSeconds: e.HLS_PLAYLIST_WAIT_SECONDS,
    },
  };

  for (const [name, block] of Object.entries(blocks)) {
    for (const key of Object.keys(block)) if (block[key] === undefined) delete block[key];
    if (Object.keys(block).length === 0) delete blocks[name];
  }
  return blocks;
}

export function loadConfig(configPath = "./config.json"): Config {
  const fileConfig = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};

  // Environment wins over the file so Docker deployments can stay file-free.
  const merged: Record<string, unknown> = { ...fileConfig, ...fromEnv() };

  // Merged key by key, so setting one nested variable does not discard the rest of the
  // block the config file supplied.
  for (const [name, block] of Object.entries(nestedFromEnv())) {
    const existing = (fileConfig[name] ?? {}) as Record<string, unknown>;
    merged[name] = { ...existing, ...block };
  }

  const parsed = configSchema.parse(merged);
  return {
    ...parsed,
    dataDir: resolve(parsed.dataDir),
    channelsFile: resolve(parsed.channelsFile),
  };
}

export function loadChannels(path: string): ChannelDef[] {
  if (!existsSync(path)) {
    throw new Error(
      `No channels file at ${path}. Copy channels.example.json to channels.json to get started.`,
    );
  }
  const parsed = channelsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));

  const seen = new Set<string>();
  for (const ch of parsed.channels) {
    if (seen.has(ch.id)) throw new Error(`duplicate channel id: ${ch.id}`);
    seen.add(ch.id);
  }
  return parsed.channels;
}

/** The URL Stremio should use. Falls back to the bind address for local-only setups. */
export function baseUrl(config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}
