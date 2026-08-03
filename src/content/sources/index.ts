import type {
  ChannelDef,
  Config,
  ContentPoolDef,
  ContentRef,
  SourceDef,
} from "../../config.ts";
import type { Db } from "../../db.ts";
import { logger } from "../../log.ts";
import { fetchMdbList, fetchStremioLibrary, fetchTraktList, MissingCredentialError } from "./imports.ts";
import { fetchRule, type RuleMatch } from "./rule.ts";
import { fetchTmdbRule } from "./tmdb.ts";

const log = logger("sources");

export { MissingCredentialError };
export type { RuleMatch };

/** Fetches a source's titles, ignoring any cache. Used by the UI's rule preview. */
export async function fetchSource(source: SourceDef, config: Config, db?: Db): Promise<RuleMatch[]> {
  switch (source.kind) {
    case "rule":
      return fetchRule(source);
    case "mdblist":
      return fetchMdbList(source, config);
    case "trakt":
      return fetchTraktList(source, config);
    case "stremio":
      return fetchStremioLibrary(source, config);
    case "tmdb":
      return fetchTmdbRule(source, config, db);
  }
}

/** Which config setting a source kind needs, or null when it needs none. */
export function requiredSetting(kind: SourceDef["kind"]): string | null {
  return {
    rule: null,
    mdblist: "mdblistApiKey",
    trakt: "traktClientId",
    stremio: "stremioAuthKey",
    tmdb: "tmdbReadAccessToken",
  }[kind];
}

interface CachedPool {
  refs: ContentRef[];
  names: Record<string, string>;
}

/**
 * A channel's content, with any source resolved and merged in.
 *
 * The result is cached for `refreshHours` because a source is a network call and pool
 * building happens on every generation pass. Just as important, a stale cache is
 * preferred to an empty channel: if the source is unreachable, the last known good list
 * keeps the channel on air.
 */
export async function resolveChannelContent(
  channel: ChannelDef,
  db: Db,
  config: Config,
): Promise<{ content: ContentRef[]; names: Record<string, string> }> {
  if (!channel.source) return { content: channel.content, names: {} };

  return resolveContentSet(
    `source:${channel.id}`,
    channel.content,
    channel.source,
    [],
    channel.refreshHours,
    db,
    config,
  );
}

export interface ResolvedProgramming {
  defaultContent: ContentRef[];
  pools: Map<string, ContentRef[]>;
  names: Record<string, string>;
}

/** Resolves every named pool once and prepares the channel's merged default pool. */
export async function resolveChannelProgramming(
  channel: ChannelDef,
  db: Db,
  config: Config,
): Promise<ResolvedProgramming> {
  if (channel.pools.length === 0) {
    const legacy = await resolveChannelContent(channel, db, config);
    return { defaultContent: legacy.content, pools: new Map(), names: legacy.names };
  }

  const pools = new Map<string, ContentRef[]>();
  const names: Record<string, string> = {};
  for (const pool of channel.pools) {
    const resolved = await resolvePool(channel.id, pool, db, config);
    pools.set(pool.id, resolved.content);
    Object.assign(names, resolved.names);
  }
  return {
    defaultContent: mergeContent(channel.defaultPoolIds.flatMap((id) => pools.get(id) ?? [])),
    pools,
    names,
  };
}

async function resolvePool(
  channelId: string,
  pool: ContentPoolDef,
  db: Db,
  config: Config,
): Promise<{ content: ContentRef[]; names: Record<string, string> }> {
  return resolveContentSet(
    `source:${channelId}:pool:${pool.id}`,
    pool.content,
    pool.source,
    pool.excluded,
    pool.refreshHours,
    db,
    config,
  );
}

async function resolveContentSet(
  scope: string,
  pinned: ContentRef[],
  source: SourceDef | undefined,
  excluded: { type: "movie" | "series"; id: string }[],
  refreshHours: number,
  db: Db,
  config: Config,
): Promise<{ content: ContentRef[]; names: Record<string, string> }> {
  if (!source) return { content: mergeContent(pinned), names: {} };

  const key = `${scope}:${JSON.stringify(source)}:${JSON.stringify(excluded)}`;
  const ttlMs = refreshHours * 3600_000;

  const cached = db.getCached<CachedPool>(key, ttlMs);
  if (cached) {
    return { content: mergeContent([...pinned, ...cached.refs]), names: cached.names };
  }

  let matches: RuleMatch[] = [];
  try {
    matches = await fetchSource(source, config, db);
  } catch (err) {
    if (err instanceof MissingCredentialError) {
      log.warn(`${scope}: ${err.message}; using pinned content only`);
    } else {
      log.error(`${scope}: source failed`, err instanceof Error ? err.message : err);
    }
    // Fall back to any previous result, however old, before giving up on the channel.
    const stale = db.getCached<CachedPool>(key, Number.MAX_SAFE_INTEGER);
    if (stale) {
      log.warn(`${scope}: reusing the last known source result`);
      return { content: mergeContent([...pinned, ...stale.refs]), names: stale.names };
    }
    return { content: mergeContent(pinned), names: {} };
  }

  if (matches.length === 0) {
    const stale = db.getCached<CachedPool>(key, Number.MAX_SAFE_INTEGER);
    if (stale) return { content: mergeContent([...pinned, ...stale.refs]), names: stale.names };
    log.warn(`${scope}: source returned nothing`);
    return { content: mergeContent(pinned), names: {} };
  }

  const excludedKeys = new Set(excluded.map((item) => `${item.type}:${item.id}`));
  const included = matches.filter((match) => !excludedKeys.has(`${match.ref.type}:${match.ref.id}`));
  const pool: CachedPool = {
    refs: included.map((m) => m.ref),
    names: Object.fromEntries(included.map((m) => [m.ref.id, m.name])),
  };
  db.putCached(key, pool);
  log.info(`${scope}: source produced ${pool.refs.length} titles`);

  return { content: mergeContent([...pinned, ...pool.refs]), names: pool.names };
}

function mergeContent(content: readonly ContentRef[]): ContentRef[] {
  const seen = new Set<string>();
  return content.filter((entry) => {
    const key = `${entry.type}:${entry.id}:${entry.season ?? ""}:${entry.episode ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
