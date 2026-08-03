import type { ContentRef, SourceDef } from "../../config.ts";
import { logger } from "../../log.ts";

const log = logger("source:rule");
const CINEMETA = "https://v3-cinemeta.strem.io";

/**
 * Cinemeta's `top` catalog is the one worth paging.
 *
 * The `imdbRating` catalog sounds right but is ordered by recency and runs dry after a
 * few hundred entries, so anything older than about 2000 is unreachable through it. `top`
 * pages past 1000 and spans back to the 1900s, which is what makes era rules workable.
 */
const CATALOG = "top";
const PAGE_SIZE = 50;
/** Ceiling on paging, so a rule matching almost nothing cannot hammer Cinemeta forever. */
const MAX_PAGES = 24;

interface CatalogMeta {
  id?: string;
  name?: string;
  releaseInfo?: string | number;
  imdbRating?: string | number;
  genres?: string[];
}

export interface RuleMatch {
  ref: ContentRef;
  name: string;
  year: number | null;
  rating: number | null;
  votes?: number | null;
  poster?: string | null;
  overview?: string | null;
}

/** Extracts the first year from Cinemeta's freeform releaseInfo ("1994", "1994–2004"). */
export function parseYear(releaseInfo: string | number | undefined): number | null {
  const match = /(\d{4})/.exec(String(releaseInfo ?? ""));
  return match ? Number(match[1]) : null;
}

export function matchesRule(
  meta: CatalogMeta,
  rule: Extract<SourceDef, { kind: "rule" }>,
): boolean {
  if (!meta.id?.startsWith("tt")) return false;

  const year = parseYear(meta.releaseInfo);
  if (rule.years) {
    const [from, to] = rule.years;
    // A title with no usable year cannot be shown to satisfy a year rule, so exclude it
    // rather than quietly widening the range the user asked for.
    if (year === null || year < from || year > to) return false;
  }

  if (rule.minRating !== undefined) {
    const rating = Number(meta.imdbRating);
    if (!Number.isFinite(rating) || rating < rule.minRating) return false;
  }

  return true;
}

/**
 * Builds a channel's content from genre, year and rating filters.
 *
 * Cinemeta cannot filter by year or rating server-side, so the catalog is paged and
 * filtered here. That is why paging depth matters: a narrow era rule needs to look at a
 * lot of entries to find enough matches.
 */
export async function fetchRule(
  rule: Extract<SourceDef, { kind: "rule" }>,
): Promise<RuleMatch[]> {
  const genres = rule.genres.length > 0 ? rule.genres : [null];
  const seen = new Set<string>();
  const matches: RuleMatch[] = [];

  for (const genre of genres) {
    for (let page = 0; page < MAX_PAGES && matches.length < rule.limit; page++) {
      const extras = [
        genre ? `genre=${encodeURIComponent(genre)}` : null,
        page > 0 ? `skip=${page * PAGE_SIZE}` : null,
      ].filter(Boolean);

      const path =
        `${CINEMETA}/catalog/${rule.type}/${CATALOG}/` +
        `${extras.length ? `${extras.join("&")}.json` : ".json"}`;

      let metas: CatalogMeta[];
      try {
        const res = await fetch(path.replace("//.json", "/.json"), {
          signal: AbortSignal.timeout(20_000),
          redirect: "follow",
        });
        if (!res.ok) break;
        metas = ((await res.json()) as { metas?: CatalogMeta[] }).metas ?? [];
      } catch (err) {
        log.warn(`catalog page failed`, err instanceof Error ? err.message : err);
        break;
      }

      // An empty page means the catalog is exhausted for this genre.
      if (metas.length === 0) break;

      for (const meta of metas) {
        if (matches.length >= rule.limit) break;
        if (!matchesRule(meta, rule)) continue;
        if (seen.has(meta.id!)) continue;
        seen.add(meta.id!);
        matches.push({
          ref: { type: rule.type, id: meta.id! },
          name: meta.name ?? meta.id!,
          year: parseYear(meta.releaseInfo),
          rating: Number.isFinite(Number(meta.imdbRating)) ? Number(meta.imdbRating) : null,
        });
      }
    }
  }

  log.info(
    `rule matched ${matches.length} ${rule.type}s` +
      (rule.genres.length ? ` in ${rule.genres.join("/")}` : "") +
      (rule.years ? ` ${rule.years[0]}-${rule.years[1]}` : "") +
      (rule.minRating ? ` rated ${rule.minRating}+` : ""),
  );
  return matches;
}
