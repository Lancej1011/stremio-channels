import type { Config, ContentRef, SourceDef } from "../../config.ts";
import { logger } from "../../log.ts";
import type { RuleMatch } from "./rule.ts";

const log = logger("source:import");

/**
 * Raised when a source needs credentials that are not configured. Distinct from a
 * failure, so the UI can say "add a key" rather than "something went wrong".
 */
export class MissingCredentialError extends Error {
  constructor(readonly setting: string) {
    super(`${setting} is not set in config.json`);
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) {
      log.warn(`${new URL(url).host} returned ${res.status}`);
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn(`request failed`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Pulls "user" and "list" out of a list URL, or a bare `user/list` pair.
 *
 * The two services order the path differently — Trakt is `/users/{user}/lists/{list}`
 * and MDBList is `/lists/{user}/{list}` — so both shapes are matched explicitly rather
 * than by grabbing whatever follows "lists/".
 */
export function parseListUrl(input: string): { user: string; list: string } | null {
  const cleaned = input.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");

  const trakt = /\/users\/([^/]+)\/lists\/([^/]+)$/.exec(cleaned);
  if (trakt) return { user: trakt[1]!, list: trakt[2]! };

  const mdblist = /\/lists\/([^/]+)\/([^/]+)$/.exec(cleaned);
  if (mdblist) return { user: mdblist[1]!, list: mdblist[2]! };

  const bare = /^([^/\s]+)\/([^/\s]+)$/.exec(cleaned);
  if (bare) return { user: bare[1]!, list: bare[2]! };

  return null;
}

interface MdbItem {
  imdb_id?: string;
  imdbid?: string;
  mediatype?: string;
  title?: string;
  release_year?: number;
}

export async function fetchMdbList(
  source: Extract<SourceDef, { kind: "mdblist" }>,
  config: Config,
): Promise<RuleMatch[]> {
  if (!config.mdblistApiKey) throw new MissingCredentialError("mdblistApiKey");

  const parsed = parseListUrl(source.url);
  if (!parsed) {
    log.warn(`could not read a user/list out of "${source.url}"`);
    return [];
  }

  const data = await getJson<MdbItem[] | { movies?: MdbItem[]; shows?: MdbItem[] }>(
    `https://api.mdblist.com/lists/${encodeURIComponent(parsed.user)}/` +
      `${encodeURIComponent(parsed.list)}/items?apikey=${encodeURIComponent(config.mdblistApiKey)}`,
  );
  if (!data) return [];

  // The API returns either a flat array or movies/shows buckets depending on the list.
  const items = Array.isArray(data) ? data : [...(data.movies ?? []), ...(data.shows ?? [])];

  return items
    .map((item): RuleMatch | null => {
      const id = item.imdb_id ?? item.imdbid;
      if (!id?.startsWith("tt")) return null;
      const type: ContentRef["type"] = item.mediatype === "show" ? "series" : "movie";
      return {
        ref: { type, id },
        name: item.title ?? id,
        year: item.release_year ?? null,
        rating: null,
      };
    })
    .filter((x): x is RuleMatch => x !== null)
    .slice(0, source.limit);
}

interface TraktItem {
  type?: string;
  movie?: { title?: string; year?: number; ids?: { imdb?: string } };
  show?: { title?: string; year?: number; ids?: { imdb?: string } };
}

export async function fetchTraktList(
  source: Extract<SourceDef, { kind: "trakt" }>,
  config: Config,
): Promise<RuleMatch[]> {
  if (!config.traktClientId) throw new MissingCredentialError("traktClientId");

  const parsed = parseListUrl(source.url);
  if (!parsed) {
    log.warn(`could not read a user/list out of "${source.url}"`);
    return [];
  }

  const data = await getJson<TraktItem[]>(
    `https://api.trakt.tv/users/${encodeURIComponent(parsed.user)}/lists/` +
      `${encodeURIComponent(parsed.list)}/items?limit=${source.limit}`,
    {
      "trakt-api-version": "2",
      "trakt-api-key": config.traktClientId,
    },
  );
  if (!data) return [];

  return data
    .map((item): RuleMatch | null => {
      const entry = item.movie ?? item.show;
      const id = entry?.ids?.imdb;
      if (!id?.startsWith("tt")) return null;
      return {
        ref: { type: item.show ? "series" : "movie", id },
        name: entry?.title ?? id,
        year: entry?.year ?? null,
        rating: null,
      };
    })
    .filter((x): x is RuleMatch => x !== null)
    .slice(0, source.limit);
}

interface StremioLibraryItem {
  _id?: string;
  type?: string;
  name?: string;
  removed?: boolean;
  temp?: boolean;
}

/**
 * Reads the user's own Stremio library.
 *
 * Authenticates with an auth key the user pastes into config, never a password: this
 * server should not be in the business of holding Stremio credentials.
 */
export async function fetchStremioLibrary(
  source: Extract<SourceDef, { kind: "stremio" }>,
  config: Config,
): Promise<RuleMatch[]> {
  if (!config.stremioAuthKey) throw new MissingCredentialError("stremioAuthKey");

  let items: StremioLibraryItem[] = [];
  try {
    const res = await fetch("https://api.strem.io/api/datastoreGet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authKey: config.stremioAuthKey,
        collection: "libraryItem",
        all: true,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      log.warn(`Stremio API returned ${res.status}`);
      return [];
    }
    items = ((await res.json()) as { result?: StremioLibraryItem[] }).result ?? [];
  } catch (err) {
    log.warn("Stremio library request failed", err instanceof Error ? err.message : err);
    return [];
  }

  return items
    .filter((item) => !item.removed)
    // `temp` marks something merely opened rather than deliberately saved; that is the
    // difference between the library and everything the user has ever clicked on.
    .filter((item) => (source.include === "all" ? true : source.include === "library" ? !item.temp : item.temp))
    .map((item): RuleMatch | null => {
      const id = item._id;
      if (!id?.startsWith("tt")) return null;
      return {
        ref: { type: item.type === "series" ? "series" : "movie", id },
        name: item.name ?? id,
        year: null,
        rating: null,
      };
    })
    .filter((x): x is RuleMatch => x !== null)
    .slice(0, source.limit);
}
