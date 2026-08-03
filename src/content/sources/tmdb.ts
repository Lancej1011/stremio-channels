import type { Config, SourceDef } from "../../config.ts";
import type { Db } from "../../db.ts";
import { logger } from "../../log.ts";
import { MissingCredentialError } from "./imports.ts";
import type { RuleMatch } from "./rule.ts";

const log = logger("source:tmdb");
const BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w342";
const META_CACHE_MS = 30 * 24 * 60 * 60_000;
const OPTIONS_CACHE_MS = 7 * 24 * 60 * 60_000;
const SIMILAR_CACHE_MS = 7 * 24 * 60 * 60_000;
const SIMILAR_LIMIT = 30;

type TmdbSource = Extract<SourceDef, { kind: "tmdb" }>;

interface DiscoverResult {
  id?: number;
  adult?: boolean;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  poster_path?: string | null;
  overview?: string;
}

interface Page<T> {
  page?: number;
  total_pages?: number;
  results?: T[];
}

interface FindResult {
  movie_results?: DiscoverResult[];
  tv_results?: DiscoverResult[];
}

export interface NamedTmdbId {
  id: number;
  name: string;
}

export type SimilarReason = "recommendation" | "similar";

export interface TmdbSimilarTitle extends RuleMatch {
  reasons: SimilarReason[];
}

export interface TmdbSimilarResult {
  seed: { id: string; type: "movie" | "series"; name: string; tmdbId: number };
  titles: TmdbSimilarTitle[];
  /** Candidates omitted because TMDB had no usable IMDb mapping. */
  skipped: number;
}

export class TmdbSeedNotFoundError extends Error {
  constructor(readonly imdbId: string) {
    super(`TMDB could not find ${imdbId}`);
    this.name = "TmdbSeedNotFoundError";
  }
}

export const COMMON_NETWORKS: NamedTmdbId[] = [
  { id: 2, name: "ABC" },
  { id: 6, name: "NBC" },
  { id: 13, name: "Nickelodeon" },
  { id: 16, name: "CBS" },
  { id: 19, name: "FOX" },
  { id: 47, name: "Comedy Central" },
  { id: 49, name: "HBO" },
  { id: 54, name: "Disney Channel" },
  { id: 56, name: "Cartoon Network" },
  { id: 77, name: "Syfy" },
  { id: 80, name: "Adult Swim" },
  { id: 88, name: "FX" },
  { id: 174, name: "AMC" },
  { id: 213, name: "Netflix" },
  { id: 2552, name: "Apple TV+" },
];

export async function fetchTmdbRule(
  source: TmdbSource,
  config: Config,
  db?: Db,
): Promise<RuleMatch[]> {
  token(config);
  const matches: RuleMatch[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 500 && matches.length < source.limit; page++) {
    const params = discoverParams(source, page);
    const mediaType = source.type === "series" ? "tv" : "movie";
    const data = await getJson<Page<DiscoverResult>>(
      `${BASE}/discover/${mediaType}?${params}`,
      config,
    );
    const results = data.results ?? [];
    if (results.length === 0) break;

    const mapped = await mapLimit(results, 4, async (item): Promise<RuleMatch | null> => {
      if (!Number.isInteger(item.id)) return null;
      const imdb = await externalImdb(mediaType, item.id!, config, db);
      if (!imdb?.startsWith("tt")) return null;
      return {
        ref: { type: source.type, id: imdb },
        name: item.title ?? item.name ?? imdb,
        year: yearOf(item.release_date ?? item.first_air_date),
        rating: Number.isFinite(item.vote_average) ? item.vote_average! : null,
        votes: Number.isFinite(item.vote_count) ? item.vote_count! : null,
        poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : null,
        overview: item.overview ?? null,
      };
    });

    for (const item of mapped) {
      if (!item || seen.has(item.ref.id)) continue;
      seen.add(item.ref.id);
      matches.push(item);
      if (matches.length >= source.limit) break;
    }

    if (page >= Math.min(data.total_pages ?? page, 500)) break;
  }

  log.info(`rule matched ${matches.length} ${source.type} titles through TMDB`);
  return matches;
}

/**
 * Blends TMDB's recommendation ranking with its genre/keyword similarity results.
 * Suggestions are metadata only: converting them to IMDb ids does not touch TorBox or
 * any persisted channel definition.
 */
export async function fetchTmdbSimilar(
  type: "movie" | "series",
  imdbId: string,
  config: Config,
  db: Db,
): Promise<TmdbSimilarResult> {
  token(config);
  const cacheKey = `tmdb:similar:v1:${type}:${imdbId}`;
  const cached = db.getCached<TmdbSimilarResult>(cacheKey, SIMILAR_CACHE_MS);
  if (cached) return cached;

  const found = await getJson<FindResult>(
    `${BASE}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&language=en-US`,
    config,
  );
  const seed = (type === "series" ? found.tv_results : found.movie_results)?.find(
    (item) => Number.isInteger(item.id),
  );
  if (!seed?.id) throw new TmdbSeedNotFoundError(imdbId);

  const mediaType = type === "series" ? "tv" : "movie";
  const [recommendations, similar] = await Promise.allSettled([
    getJson<Page<DiscoverResult>>(`${BASE}/${mediaType}/${seed.id}/recommendations?language=en-US&page=1`, config),
    getJson<Page<DiscoverResult>>(`${BASE}/${mediaType}/${seed.id}/similar?language=en-US&page=1`, config),
  ]);
  if (recommendations.status === "rejected" && similar.status === "rejected") {
    throw recommendations.reason;
  }

  const candidates = new Map<number, { item: DiscoverResult; reasons: SimilarReason[] }>();
  const add = (items: DiscoverResult[], reason: SimilarReason) => {
    for (const item of items) {
      if (!Number.isInteger(item.id) || item.id === seed.id || item.adult === true) continue;
      const existing = candidates.get(item.id!);
      if (existing) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        candidates.set(item.id!, { item, reasons: [reason] });
      }
    }
  };
  // Map insertion order is the product ranking: recommendations first, similarity fill.
  if (recommendations.status === "fulfilled") add(recommendations.value.results ?? [], "recommendation");
  if (similar.status === "fulfilled") add(similar.value.results ?? [], "similar");

  const mapped = await mapLimit([...candidates.values()], 4, async ({ item, reasons }) => {
    const resolvedImdb = await externalImdb(mediaType, item.id!, config, db);
    if (!resolvedImdb?.startsWith("tt") || resolvedImdb === imdbId) return null;
    return {
      ref: { type, id: resolvedImdb },
      name: item.title ?? item.name ?? resolvedImdb,
      year: yearOf(item.release_date ?? item.first_air_date),
      rating: Number.isFinite(item.vote_average) ? item.vote_average! : null,
      votes: Number.isFinite(item.vote_count) ? item.vote_count! : null,
      poster: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : null,
      overview: item.overview ?? null,
      reasons,
    } satisfies TmdbSimilarTitle;
  });

  const unique = new Map<string, TmdbSimilarTitle>();
  let skipped = 0;
  for (const title of mapped) {
    if (!title) { skipped++; continue; }
    const existing = unique.get(title.ref.id);
    if (existing) {
      for (const reason of title.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      unique.set(title.ref.id, title);
    }
  }

  const result: TmdbSimilarResult = {
    seed: {
      id: imdbId,
      type,
      name: seed.title ?? seed.name ?? imdbId,
      tmdbId: seed.id,
    },
    titles: [...unique.values()].slice(0, SIMILAR_LIMIT),
    skipped,
  };
  db.putCached(cacheKey, result);
  return result;
}

function discoverParams(source: TmdbSource, page: number): URLSearchParams {
  const params = new URLSearchParams({
    page: String(page),
    include_adult: "false",
    sort_by: sortValue(source),
  });
  const set = (name: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") params.set(name, String(value));
  };
  const ids = (items: NamedTmdbId[]) => items.map((item) => item.id).join("|");

  set("with_genres", ids(source.includeGenres));
  set("without_genres", ids(source.excludeGenres));
  set("vote_average.gte", source.minRating);
  set("vote_count.gte", source.minVotes ?? (source.sort === "rating" ? 100 : undefined));
  set("with_runtime.gte", source.runtime?.[0]);
  set("with_runtime.lte", source.runtime?.[1]);
  set("with_original_language", source.languages.join("|"));
  set("with_origin_country", source.countries.join("|"));
  set("with_companies", ids(source.companies));
  set("with_keywords", ids(source.includeKeywords));
  set("without_keywords", ids(source.excludeKeywords));
  if (source.type === "series") set("with_networks", ids(source.networks));

  if (source.years) {
    const prefix = source.type === "series" ? "first_air_date" : "primary_release_date";
    set(`${prefix}.gte`, `${source.years[0]}-01-01`);
    set(`${prefix}.lte`, `${source.years[1]}-12-31`);
  }
  return params;
}

function sortValue(source: TmdbSource): string {
  if (source.sort === "rating") return "vote_average.desc";
  if (source.sort === "newest") {
    return source.type === "series" ? "first_air_date.desc" : "primary_release_date.desc";
  }
  return "popularity.desc";
}

async function externalImdb(
  mediaType: "movie" | "tv",
  id: number,
  config: Config,
  db?: Db,
): Promise<string | null> {
  const key = `tmdb:external:${mediaType}:${id}`;
  const cached = db?.getCached<{ imdb_id?: string | null }>(key, META_CACHE_MS);
  if (cached) return cached.imdb_id ?? null;

  const data = await getJson<{ imdb_id?: string | null }>(
    `${BASE}/${mediaType}/${id}/external_ids`,
    config,
  );
  db?.putCached(key, { imdb_id: data.imdb_id ?? null });
  return data.imdb_id ?? null;
}

export async function tmdbOptions(config: Config, db: Db): Promise<{
  configured: boolean;
  genres: { movie: NamedTmdbId[]; series: NamedTmdbId[] };
  languages: { code: string; name: string }[];
  countries: { code: string; name: string }[];
  networks: NamedTmdbId[];
}> {
  if (!hasCredential(config)) {
    return { configured: false, genres: { movie: [], series: [] }, languages: [], countries: [], networks: COMMON_NETWORKS };
  }

  const key = "tmdb:options:v1";
  const cached = db.getCached<Awaited<ReturnType<typeof tmdbOptions>>>(key, OPTIONS_CACHE_MS);
  if (cached) return { ...cached, configured: true };

  const [movieGenres, tvGenres, languages, countries] = await Promise.all([
    getJson<{ genres?: NamedTmdbId[] }>(`${BASE}/genre/movie/list?language=en`, config),
    getJson<{ genres?: NamedTmdbId[] }>(`${BASE}/genre/tv/list?language=en`, config),
    getJson<{ iso_639_1?: string; english_name?: string; name?: string }[]>(`${BASE}/configuration/languages`, config),
    getJson<{ iso_3166_1?: string; english_name?: string; native_name?: string }[]>(`${BASE}/configuration/countries`, config),
  ]);
  const result = {
    configured: true,
    genres: { movie: movieGenres.genres ?? [], series: tvGenres.genres ?? [] },
    languages: languages
      .filter((item) => item.iso_639_1)
      .map((item) => ({ code: item.iso_639_1!, name: item.english_name || item.name || item.iso_639_1! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    countries: countries
      .filter((item) => item.iso_3166_1)
      .map((item) => ({ code: item.iso_3166_1!, name: item.english_name || item.native_name || item.iso_3166_1! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    networks: COMMON_NETWORKS,
  };
  db.putCached(key, result);
  return result;
}

export async function searchTmdbMetadata(
  kind: "company" | "keyword" | "network",
  query: string,
  config: Config,
): Promise<NamedTmdbId[]> {
  if (kind === "network") {
    const q = query.toLowerCase();
    return COMMON_NETWORKS.filter((item) => item.name.toLowerCase().includes(q)).slice(0, 20);
  }
  token(config);
  const data = await getJson<Page<NamedTmdbId>>(
    `${BASE}/search/${kind}?query=${encodeURIComponent(query)}&page=1`,
    config,
  );
  return (data.results ?? []).filter((item) => Number.isInteger(item.id) && item.name).slice(0, 20);
}

async function getJson<T>(url: string, config: Config): Promise<T> {
  const auth = credential(config);
  const target = new URL(url);
  if (auth.apiKey) target.searchParams.set("api_key", auth.apiKey);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  const res = await fetch(target, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`TMDB returned ${res.status}`);
  }
  return (await res.json()) as T;
}

function token(config: Config): string {
  const auth = credential(config);
  return auth.bearer ?? auth.apiKey!;
}

function hasCredential(config: Config): boolean {
  return Boolean(config.tmdbReadAccessToken || config.tmdbApiKey);
}

function credential(config: Config): { bearer?: string; apiKey?: string } {
  if (config.tmdbReadAccessToken) return { bearer: config.tmdbReadAccessToken };
  if (config.tmdbApiKey) return { apiKey: config.tmdbApiKey };
  throw new MissingCredentialError("tmdbReadAccessToken or tmdbApiKey");
}

function yearOf(value: string | undefined): number | null {
  const year = Number(value?.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : null;
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await fn(values[index]!);
    }
  }));
  return result;
}
