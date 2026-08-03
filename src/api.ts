import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChannelService } from "./channels.ts";
import { writeChannelsFile } from "./channels-file.ts";
import { channelSchema, loadChannels, sourceSchema, type ChannelDef, type Config } from "./config.ts";
import { fetchSource, MissingCredentialError, requiredSetting } from "./content/sources/index.ts";
import {
  fetchTmdbSimilar,
  searchTmdbMetadata,
  TmdbSeedNotFoundError,
  tmdbOptions,
} from "./content/sources/tmdb.ts";
import type { Db } from "./db.ts";
import { logger } from "./log.ts";
import { findPreset, instantiate, loadPresets } from "./presets.ts";
import { getGuide } from "./schedule/clock.ts";
import { apiCallStats, cooldownRemainingSeconds } from "./content/providers/torbox.ts";

const log = logger("api");

const CINEMETA = "https://v3-cinemeta.strem.io";
const TVMAZE = "https://api.tvmaze.com";

/** Cinemeta's own genre lists, so the UI offers exactly what the catalogs accept. */
const MOVIE_GENRES = [
  "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary",
  "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi",
  "Sport", "Thriller", "War", "Western",
];
const SERIES_GENRES = [
  ...MOVIE_GENRES, "Reality-TV", "Talk-Show", "Game-Show",
];

export function registerApi(
  app: FastifyInstance,
  service: ChannelService,
  db: Db,
  config: Config,
  onReload: (channels: ChannelDef[]) => void,
): void {
  // ------------------------------------------------------------------ channels

  app.get("/api/channels", async () => ({ channels: await service.listWithNames() }));

  app.put<{ Body: unknown }>("/api/channels", async (req, reply) => {
    const parsed = z.object({ channels: z.array(channelSchema).min(0) }).safeParse(req.body);
    if (!parsed.success) {
      // Reject before writing so a bad edit cannot destroy a working config.
      return reply.code(400).send({ error: "invalid channels", detail: parsed.error.issues });
    }

    const ids = parsed.data.channels.map((c) => c.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) return reply.code(400).send({ error: `duplicate channel id: ${duplicate}` });

    try {
      writeChannelsFile(config.channelsFile, parsed.data.channels);
    } catch (err) {
      log.error("failed to write channels file", err);
      return reply.code(500).send({ error: "could not write channels.json" });
    }

    onReload(parsed.data.channels);
    return { ok: true, channels: parsed.data.channels };
  });

  /** Re-reads channels.json from disk, for when it was edited by hand. */
  app.post("/api/channels/reload", async (reply) => {
    try {
      const channels = loadChannels(config.channelsFile);
      onReload(channels);
      return { ok: true, channels };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ------------------------------------------------------------------ discovery

  app.get<{ Querystring: { q?: string; type?: string } }>("/api/search", async (req, reply) => {
    const query = (req.query.q ?? "").trim();
    if (query.length < 2) return { results: [] };

    // Search both catalogues so a channel can mix films and shows without the user
    // having to know which is which up front.
    const types = req.query.type === "movie" || req.query.type === "series"
      ? [req.query.type]
      : ["series", "movie"];

    const results = await Promise.all(
      types.map(async (type) => {
        try {
          const res = await fetch(
            `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,
            { signal: AbortSignal.timeout(15_000) },
          );
          if (!res.ok) return [];
          const metas = ((await res.json()) as { metas?: Record<string, unknown>[] }).metas ?? [];
          return metas.slice(0, 12).map((m) => ({
            id: m.id as string,
            type,
            name: m.name as string,
            year: (m.releaseInfo as string) ?? "",
            poster: (m.poster as string) ?? null,
          }));
        } catch {
          return [];
        }
      }),
    );

    reply.header("Cache-Control", "max-age=300");
    return { results: results.flat() };
  });

  /**
   * Which network a show belonged to and when it ran. This is what makes building an
   * era-accurate lineup by hand practical rather than guesswork.
   */
  app.get<{ Params: { imdbId: string } }>("/api/lookup/:imdbId", async (req, reply) => {
    const { imdbId } = req.params;
    if (!/^tt\d+$/.test(imdbId)) return reply.code(400).send({ error: "not an IMDb id" });

    const cacheKey = `tvmaze:${imdbId}`;
    const cached = db.getCached<unknown>(cacheKey, 7 * 24 * 60 * 60 * 1000);
    if (cached) return cached;

    try {
      const res = await fetch(`${TVMAZE}/lookup/shows?imdb=${imdbId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { network: null, premiered: null, ended: null };

      const show = (await res.json()) as Record<string, any>;
      const info = {
        name: show.name ?? null,
        network: (show.network ?? show.webChannel ?? {})?.name ?? null,
        premiered: show.premiered ?? null,
        ended: show.ended ?? null,
        genres: show.genres ?? [],
      };
      db.putCached(cacheKey, info);
      return info;
    } catch {
      return { network: null, premiered: null, ended: null };
    }
  });

  // ------------------------------------------------------------------ smart sources

  /** Which source kinds this install can actually use, so the UI hides the rest. */
  app.get("/api/sources", async () => ({
    genres: {
      movie: MOVIE_GENRES,
      series: SERIES_GENRES,
    },
    kinds: (["rule", "tmdb", "mdblist", "trakt", "stremio"] as const).map((kind) => {
      const setting = requiredSetting(kind);
      return {
        kind,
        available: kind === "tmdb"
          ? Boolean(config.tmdbReadAccessToken || config.tmdbApiKey)
          : setting === null || Boolean((config as Record<string, unknown>)[setting]),
        requires: kind === "tmdb" ? "tmdbReadAccessToken or tmdbApiKey" : setting,
      };
    }),
  }));

  app.get("/api/metadata/options", async (_req, reply) => {
    try {
      return await tmdbOptions(config, db);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { kind?: string; q?: string } }>(
    "/api/metadata/search",
    async (req, reply) => {
      const parsed = z.object({
        kind: z.enum(["company", "keyword", "network"]),
        q: z.string().trim().min(1).max(100),
      }).safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid metadata search" });
      try {
        return { results: await searchTmdbMetadata(parsed.data.kind, parsed.data.q, config) };
      } catch (err) {
        if (err instanceof MissingCredentialError) {
          return reply.code(400).send({ error: err.message, missing: err.setting });
        }
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /** Metadata-only discovery for a hand-picked title; never resolves availability. */
  app.get<{ Querystring: { type?: string; id?: string } }>(
    "/api/metadata/similar",
    async (req, reply) => {
      const parsed = z.object({
        type: z.enum(["movie", "series"]),
        id: z.string().regex(/^tt\d+$/),
      }).safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid similar-content request" });

      try {
        const result = await fetchTmdbSimilar(parsed.data.type, parsed.data.id, config, db);
        reply.header("Cache-Control", "max-age=300");
        return {
          seed: result.seed,
          skipped: result.skipped,
          titles: result.titles.map((title) => ({
            id: title.ref.id,
            type: title.ref.type,
            name: title.name,
            year: title.year,
            rating: title.rating,
            votes: title.votes ?? null,
            poster: title.poster ?? null,
            overview: title.overview ?? null,
            reasons: title.reasons,
          })),
        };
      } catch (err) {
        if (err instanceof MissingCredentialError) {
          return reply.code(400).send({ error: err.message, missing: err.setting });
        }
        if (err instanceof TmdbSeedNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /**
   * Runs a source without saving it, so a rule can be checked before it goes on air.
   * Bypasses the cache deliberately: the point is to see what the rule matches *now*.
   */
  app.post<{ Body: unknown }>("/api/sources/preview", async (req, reply) => {
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid source", detail: parsed.error.issues });
    }

    try {
      const matches = await fetchSource(parsed.data, config, db);
      return {
        count: matches.length,
        titles: matches.map((m) => ({
          id: m.ref.id,
          type: m.ref.type,
          name: m.name,
          year: m.year,
          rating: m.rating,
          votes: m.votes ?? null,
          poster: m.poster ?? null,
          overview: m.overview ?? null,
        })),
      };
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        return reply.code(400).send({ error: err.message, missing: err.setting });
      }
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Projects an unsaved channel without touching its persisted schedule or TorBox. */
  app.post<{ Body: unknown }>("/api/channels/preview", async (req, reply) => {
    const parsed = z.object({
      channel: channelSchema,
      hours: z.number().min(1).max(24).default(12),
    }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid channel preview", detail: parsed.error.issues });
    }

    try {
      return await service.previewChannel(parsed.data.channel, parsed.data.hours);
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        return reply.code(400).send({ error: err.message, missing: err.setting });
      }
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------------------------ presets

  app.get("/api/presets", async () => {
    const presets = loadPresets();
    const labeled = await service.channelsWithNames(presets.map((preset) => preset.channel));
    return presets.map((p, index) => {
      const existingChannelId = service.get(p.channel.id)?.id ?? null;
      return {
        key: p.key,
        label: p.label,
        summary: p.summary,
        titles: p.channel.content.length,
        dayparts: p.channel.dayparts.map((d) => ({
          name: d.name,
          start: d.start,
          end: d.end,
        })),
        channel: labeled[index],
        installed: existingChannelId !== null,
        existingChannelId,
      };
    });
  });

  app.post<{ Body: unknown }>("/api/presets/apply", async (req, reply) => {
    const body = z.object({
      key: z.string().min(1),
      mode: z.enum(["add", "replace"]).default("add"),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid preset request" });

    const preset = findPreset(body.data.key);
    if (!preset) return reply.code(404).send({ error: "no such preset" });

    const existing = service.list();
    const conflict = existing.find((channel) => channel.id === preset.channel.id);
    if (conflict && body.data.mode === "add") {
      return reply.code(409).send({
        error: `channel ${conflict.id} already represents this preset`,
        existingChannelId: conflict.id,
      });
    }
    if (!conflict && body.data.mode === "replace") {
      return reply.code(409).send({ error: `channel ${preset.channel.id} does not exist` });
    }

    const channel = instantiate(preset);
    const channels = conflict
      ? existing.map((item) => item.id === conflict.id ? channel : item)
      : [...existing, channel];
    try {
      writeChannelsFile(config.channelsFile, channels);
    } catch (err) {
      log.error("failed to apply preset", err);
      return reply.code(500).send({ error: "could not write channels.json" });
    }
    onReload(channels);
    return { ok: true, action: conflict ? "replaced" : "added", channel };
  });

  // ------------------------------------------------------------------ guide + ops

  app.get<{ Querystring: { hours?: string } }>("/api/guide", async (req) => {
    const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 12));
    const now = Date.now();
    const until = now + hours * 3600_000;

    return {
      now,
      until,
      channels: service.list().map((channel) => ({
        id: channel.id,
        name: channel.name,
        live: service.feeds.isChannelLive(channel.id),
        programs: getGuide(db, channel.id, now, 200)
          .filter((entry) => entry.program.start_ms < until)
          .map((entry) => ({
            title: entry.program.title,
            start: entry.program.start_ms,
            duration: entry.program.duration_ms,
            daypart: entry.program.daypart,
            isNow: entry.isNow,
          })),
      })),
    };
  });

  app.get("/api/status", async () => ({
    cooldownSeconds: cooldownRemainingSeconds(),
    debridCalls: apiCallStats(),
    channels: service.list().map((c) => {
      const provisioning = service.provisioning(c.id);
      return {
        id: c.id,
        name: c.name,
        live: service.feeds.isChannelLive(c.id),
        ...provisioning,
      };
    }),
  }));

  app.post<{ Params: { id: string } }>("/api/channels/:id/skip", async (req, reply) => {
    if (!service.get(req.params.id)) return reply.code(404).send({ error: "no such channel" });
    return { ok: service.skipCurrent(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/regenerate", async (req, reply) => {
    const channel = service.get(req.params.id);
    if (!channel) return reply.code(404).send({ error: "no such channel" });

    service.resetChannel(channel.id);
    void service.warmUpChannel(channel.id);
    return { ok: true };
  });
}
