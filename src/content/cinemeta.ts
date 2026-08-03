import type { ContentRef } from "../config.ts";
import type { Db } from "../db.ts";
import { logger } from "../log.ts";

const log = logger("cinemeta");
const BASE = "https://v3-cinemeta.strem.io";
const CACHE_MS = 24 * 60 * 60 * 1000;

interface CinemetaVideo {
  id?: string;
  season?: number;
  episode?: number;
  name?: string;
  title?: string;
  released?: string;
}

interface CinemetaMeta {
  id: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  /** Free text, e.g. "58 min". Good enough for a placeholder, never for the clock. */
  runtime?: string;
  genres?: string[];
  videos?: CinemetaVideo[];
}

export interface TitleInfo {
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  /** Best-effort duration from the runtime string; ffprobe supersedes it. */
  estimatedDurationMs?: number;
}

export class Cinemeta {
  constructor(private readonly db: Db) {}

  private async fetchMeta(
    type: "movie" | "series",
    id: string,
  ): Promise<CinemetaMeta | null> {
    const key = `cinemeta:${type}:${id}`;
    const cached = this.db.getCached<CinemetaMeta>(key, CACHE_MS);
    if (cached) return cached;

    try {
      const res = await fetch(`${BASE}/meta/${type}/${id}.json`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn(`meta ${type}/${id} returned ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { meta?: CinemetaMeta };
      if (!body.meta) return null;
      this.db.putCached(key, body.meta);
      return body.meta;
    } catch (err) {
      log.warn(`meta ${type}/${id} failed`, err);
      return null;
    }
  }

  /** Display info for a single scheduled item. Episodes get "Show - S01E02 - Title". */
  async titleInfo(ref: ContentRef): Promise<TitleInfo | null> {
    const meta = await this.fetchMeta(ref.type, ref.id);
    if (!meta) return null;

    const base: TitleInfo = {
      name: meta.name,
      poster: meta.poster,
      background: meta.background,
      description: meta.description,
      estimatedDurationMs: parseRuntime(meta.runtime),
    };

    if (ref.season === undefined || ref.episode === undefined) return base;

    const video = meta.videos?.find(
      (v) => v.season === ref.season && v.episode === ref.episode,
    );
    const code = `S${pad(ref.season)}E${pad(ref.episode)}`;
    const epTitle = video?.name ?? video?.title;
    return {
      ...base,
      name: epTitle ? `${meta.name} - ${code} - ${epTitle}` : `${meta.name} - ${code}`,
    };
  }

  /**
   * Turns a channel's content entry into the individual items it can air. A series
   * becomes one ref per episode, which is what lets a channel of five shows shuffle
   * across hundreds of distinct programs.
   */
  async expand(ref: ContentRef): Promise<ContentRef[]> {
    if (ref.type === "movie") return [ref];
    if (ref.season !== undefined && ref.episode !== undefined) return [ref];

    const meta = await this.fetchMeta("series", ref.id);
    if (!meta?.videos?.length) {
      log.warn(`no episode list for ${ref.id}; skipping`);
      return [];
    }

    return meta.videos
      // Season 0 is specials and extras. Including it drops oddities into rotation.
      .filter((v) => typeof v.season === "number" && v.season > 0 && typeof v.episode === "number")
      .filter((v) => ref.season === undefined || v.season === ref.season)
      .sort((a, b) => a.season! - b.season! || a.episode! - b.episode!)
      .map((v) => ({
        type: "series" as const,
        id: ref.id,
        season: v.season!,
        episode: v.episode!,
      }));
  }
}

/** "58 min" / "1h 30min" / "120" -> milliseconds. */
function parseRuntime(runtime: string | undefined): number | undefined {
  if (!runtime) return undefined;
  const hours = /(\d+)\s*h/i.exec(runtime);
  const mins = /(\d+)\s*min/i.exec(runtime);
  if (hours || mins) {
    const h = hours ? Number(hours[1]) : 0;
    const m = mins ? Number(mins[1]) : 0;
    return (h * 60 + m) * 60_000;
  }
  const bare = /^\s*(\d+)\s*$/.exec(runtime);
  return bare ? Number(bare[1]) * 60_000 : undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
