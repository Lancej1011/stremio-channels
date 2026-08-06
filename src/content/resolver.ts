import { refKey, type Config, type ContentRef } from "../config.ts";
import { logger } from "../log.ts";

const log = logger("resolver");

export interface ResolvedStream {
  url: string;
  /** Epoch ms after which the link must be re-resolved. Debrid links are short lived. */
  expiresAt: number;
  /** For logging and diagnostics; not used for playback decisions. */
  label: string;
  /**
   * Where the link came from. Recording it lets an expired link be refreshed with a
   * single request, instead of repeating discovery, cache-check and add.
   */
  torrentId?: number;
  fileId?: number;
}

/**
 * A stream whose durable delivery identifiers have been prepared, but whose short-lived
 * download URL may deliberately be deferred until the program is near airtime.
 */
export interface PreparedStream {
  url: string | null;
  expiresAt: number | null;
  label: string;
  torrentId?: number;
  fileId?: number;
}

/** Resolvers that can refresh an expired link cheaply implement this. */
export interface RefreshableResolver extends StreamResolver {
  refresh(torrentId: number, fileId: number): Promise<ResolvedStream | null>;
}

/** Direct resolvers can prepare cached media without opening an expiring CDN link. */
export interface PreparatoryResolver extends RefreshableResolver {
  prepare(ref: ContentRef, needUrl: boolean): Promise<PreparedStream | null>;
}

export interface StreamResolver {
  readonly name: string;
  resolve(ref: ContentRef): Promise<ResolvedStream | null>;
}

/** A resolver that can reject a failed release and select a different one next time. */
export interface FailoverResolver extends StreamResolver {
  invalidate(ref: ContentRef, failedUrl?: string): void;
}

interface StremioStream {
  url?: string;
  infoHash?: string;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: { notWebReady?: boolean; videoSize?: number; filename?: string };
}

/**
 * Resolves through a Stremio stream addon the user has already configured with their
 * debrid key (Torrentio, Comet, MediaFusion...). Those addons hand back direct debrid
 * HTTPS links, which are seekable — exactly what the encoder needs to join a program
 * partway through. Using them means Phase 1 needs no debrid API code of its own.
 */
export class AddonResolver implements FailoverResolver {
  readonly name = "stream-addon";
  private readonly base: string;
  private readonly rejectedUrls = new Map<string, Set<string>>();

  constructor(
    addonUrl: string,
    private readonly config: Config,
  ) {
    this.base = addonUrl.replace(/\/manifest\.json\/?$/i, "").replace(/\/$/, "");
  }

  async resolve(ref: ContentRef): Promise<ResolvedStream | null> {
    const type = ref.type;
    const id =
      ref.season !== undefined && ref.episode !== undefined
        ? `${ref.id}:${ref.season}:${ref.episode}`
        : ref.id;

    let streams: StremioStream[];
    try {
      const res = await fetch(`${this.base}/stream/${type}/${encodeURIComponent(id)}.json`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log.warn(`addon returned ${res.status} for ${id}`);
        return null;
      }
      streams = ((await res.json()) as { streams?: StremioStream[] }).streams ?? [];
    } catch (err) {
      log.warn(`addon request failed for ${id}`, err);
      return null;
    }

    // infoHash-only results are raw torrents with no HTTP endpoint behind them. They
    // cannot be seeked into, so they are useless for a linear feed.
    const rejected = this.rejectedUrls.get(refKey(ref));
    const playable = streams.filter((s) =>
      s.url && /^https?:\/\//i.test(s.url) && !rejected?.has(s.url),
    );
    if (playable.length === 0) {
      log.warn(
        `no direct links for ${id} (${streams.length} results, all torrent-only) - is your addon configured with a debrid key?`,
      );
      return null;
    }

    const best = this.pickByQuality(playable);
    return {
      url: best.url!,
      // Conservative: TorBox links last ~3h, others vary. Re-resolving early is cheap.
      expiresAt: Date.now() + 90 * 60 * 1000,
      label: (best.name ?? best.title ?? "stream").replace(/\s+/g, " ").slice(0, 80),
    };
  }

  invalidate(ref: ContentRef, failedUrl?: string): void {
    // The URL itself is enough to identify an addon result. On the next discovery pass,
    // choose the next best stream rather than asking the same CDN link to work again.
    if (!failedUrl) return;
    const key = refKey(ref);
    const rejected = this.rejectedUrls.get(key) ?? new Set<string>();
    rejected.add(failedUrl);
    this.rejectedUrls.set(key, rejected);
  }

  private pickByQuality(streams: StremioStream[]): StremioStream {
    for (const quality of this.config.qualityPreference) {
      const match = streams.find((s) =>
        `${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`
          .toLowerCase()
          .includes(quality.toLowerCase()),
      );
      if (match) return match;
    }
    // Nothing advertised a resolution we recognise; the addon already sorts by its own
    // notion of best, so take its first choice.
    return streams[0]!;
  }
}
