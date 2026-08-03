import type { ContentRef } from "../../config.ts";
import { logger } from "../../log.ts";
import { parseRelease, type ReleaseInfo } from "../quality.ts";

const log = logger("indexer");

export interface Candidate {
  hash: string;
  title: string;
  release: ReleaseInfo;
  /** Which file inside a multi-file torrent this result points at, when known. */
  fileIdx?: number;
}

interface StremioStream {
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: { videoSize?: number; filename?: string };
}

export function streamPath(ref: ContentRef): string {
  const id =
    ref.season !== undefined && ref.episode !== undefined
      ? `${ref.id}:${ref.season}:${ref.episode}`
      : ref.id;
  return `${ref.type}/${encodeURIComponent(id)}.json`;
}

/**
 * Supplies torrent hashes for a title. TorBox has no search of its own, so discovery
 * comes from a Stremio indexer addon used *without* a debrid key configured — that is
 * what makes it return raw infoHashes instead of pre-resolved links.
 */
export class IndexerClient {
  private readonly base: string;
  /**
   * Indexers are free shared services and we ask once per scheduled program. Caching
   * keeps regeneration and restarts from re-querying the same titles.
   */
  private readonly cache = new Map<string, { at: number; candidates: Candidate[] }>();
  private readonly cacheTtlMs = 6 * 60 * 60 * 1000;

  constructor(indexerUrl: string) {
    this.base = indexerUrl.replace(/\/manifest\.json\/?$/i, "").replace(/\/$/, "");
  }

  async candidates(ref: ContentRef): Promise<Candidate[]> {
    const key = streamPath(ref);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.candidates;

    let streams: StremioStream[];
    try {
      const res = await fetch(`${this.base}/stream/${key}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log.warn(`indexer returned ${res.status} for ${ref.id}`);
        return [];
      }
      streams = ((await res.json()) as { streams?: StremioStream[] }).streams ?? [];
    } catch (err) {
      log.warn(`indexer request failed for ${ref.id}`, err instanceof Error ? err.message : err);
      return [];
    }

    const candidates = streams
      .filter((s): s is StremioStream & { infoHash: string } => Boolean(s.infoHash))
      .map((s) => {
        const title = [s.name, s.title, s.description, s.behaviorHints?.filename]
          .filter(Boolean)
          .join(" ");
        return {
          hash: s.infoHash.toLowerCase(),
          title: (s.title ?? s.name ?? "").split("\n")[0] ?? "",
          release: parseRelease(title, s.behaviorHints?.videoSize ?? 0),
          fileIdx: s.fileIdx,
        };
      });

    this.cache.set(key, { at: Date.now(), candidates });
    return candidates;
  }
}
