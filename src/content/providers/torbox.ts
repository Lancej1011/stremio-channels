import { logger } from "../../log.ts";

const log = logger("torbox");
const API = "https://api.torbox.app/v1/api";

/**
 * One request per second, one at a time. TorBox answers a burst with a 429 carrying a
 * Retry-After measured in *minutes*, which costs far more than the throughput saved by
 * going faster. Schedule generation runs in the background, so it can afford to be slow.
 */
const MIN_REQUEST_GAP_MS = 1000;
const MAX_IN_FLIGHT = 1;
/**
 * Absolute ceiling on any single request. A hung fetch must never be able to wedge the
 * queue: everything behind it would wait forever, and a stalled schedule generator gives
 * no error at all, just a channel that quietly never fills.
 */
const TASK_WATCHDOG_MS = 45_000;

export interface RateLimiterOptions {
  maxInFlight?: number;
  minGapMs?: number;
  watchdogMs?: number;
}

/**
 * Paces requests to TorBox, which rate limits. Enforces both a minimum gap and a cap on
 * requests in flight, and guarantees every task settles so the queue cannot deadlock.
 */
export class RateLimiter {
  private queue: (() => void)[] = [];
  /** Permits currently free. A counting semaphore, not a re-checked counter. */
  private available: number;
  /** Wall-clock time the next request is allowed to start. */
  private nextSlotAt = 0;
  private readonly minGapMs: number;
  private readonly watchdogMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.available = options.maxInFlight ?? MAX_IN_FLIGHT;
    this.minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.watchdogMs = options.watchdogMs ?? TASK_WATCHDOG_MS;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await withTimeout(task(), this.watchdogMs);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.queue.push(resolve));

    // Reserve a start slot synchronously. Reading a "last started" timestamp instead
    // does not pace anything: tasks admitted together all observe the same stale value,
    // compute no delay, and fire simultaneously — which is what triggers 429s.
    const now = Date.now();
    const startAt = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = startAt + this.minGapMs;

    const wait = startAt - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Hands the permit directly to the next waiter, or returns it to the pool if there
   * is none. Deciding by re-reading a counter instead loses wakeups: a waiter that has
   * been resolved has not yet taken its permit, so the count still looks full and the
   * handoff is skipped with no later completion to retry it.
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available++;
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TorBoxError(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const limiter = new RateLimiter();

/**
 * Account-wide cooldown shared by every client instance. TorBox rate limits the account,
 * not the connection, so one 429 means everyone should back off.
 */
let cooldownUntil = 0;
let consecutiveRateLimits = 0;
const FALLBACK_COOLDOWNS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Seconds until TorBox will accept requests again; zero when not limited. */
export function cooldownRemainingSeconds(): number {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

/** Accepts both legal Retry-After forms: delta seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function beginCooldown(header: string | null | undefined): number {
  const explicit = retryAfterMs(header ?? null);
  const fallback = FALLBACK_COOLDOWNS_MS[
    Math.min(consecutiveRateLimits, FALLBACK_COOLDOWNS_MS.length - 1)
  ]!;
  consecutiveRateLimits++;
  const waitMs = Math.max(1_000, explicit ?? fallback);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
  return waitMs;
}

/** Test-only reset for module-wide account state. */
export function resetRateLimitState(): void {
  cooldownUntil = 0;
  consecutiveRateLimits = 0;
}

/**
 * Requests sent, by endpoint. The debrid rate limit is the binding constraint on how fast
 * channels fill, so the call count per scheduled program is the number worth watching.
 */
const requestCounts = new Map<string, number>();

export function apiCallStats(): Record<string, number> {
  return Object.fromEntries([...requestCounts.entries()].sort());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Frees a response we are not going to read, returning its connection to the pool. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed; nothing to release.
  }
}

/** Hash lists make these paths enormous; keep log lines readable. */
function label(path: string): string {
  const [route = path, query = ""] = path.split("?");
  const hashes = /hash=([^&]*)/.exec(query)?.[1]?.split(",").length;
  return hashes ? `${route} (${hashes} hashes)` : route;
}

/** Distinguishes "the request failed" from "the answer was no". */
export class TorBoxError extends Error {}

export interface CachedTorrent {
  hash: string;
  name: string;
  size: number;
  /**
   * Present when the cache check asked for file lists. Knowing the contents *before*
   * adding a torrent is what lets a season pack missing the wanted episode be rejected
   * while ranking, instead of being discovered after the slot is already committed.
   */
  files?: { id: number; name: string; size: number }[];
}

export interface UserTorrentFile {
  id: number;
  name: string;
  size: number;
}

interface UserTorrent {
  id: number;
  files?: {
    id: number;
    name?: string;
    short_name?: string;
    size?: number;
  }[];
}

interface Envelope<T> {
  success: boolean;
  detail?: string;
  data?: T;
}

/**
 * Thin TorBox client covering exactly what a linear channel needs: find out which
 * candidate torrents are already cached, add one, and turn it into a seekable link.
 *
 * TorBox has no content discovery of its own, so hashes come from an indexer addon.
 */
export class TorBoxClient {
  constructor(private readonly apiKey: string) {}

  private async call<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<T | null> {
    const cooldownLeft = cooldownUntil - Date.now();
    if (cooldownLeft > 0) {
      throw new TorBoxError(
        `TorBox rate limit active, ${Math.ceil(cooldownLeft / 1000)}s remaining`,
      );
    }

    try {
      // The whole exchange, body included, runs under one permit and one watchdog.
      // Reading the body outside would leave it untimed, and an unread body keeps its
      // connection checked out of the pool.
      const outcome = await limiter.run(async () => {
          // Re-check after queueing: a request that waited its turn may find that an
          // earlier one already tripped the limit, and sending it anyway only extends
          // the cooldown.
          if (cooldownUntil > Date.now()) {
            throw new TorBoxError(
              `TorBox rate limit active, ${cooldownRemainingSeconds()}s remaining`,
            );
          }

          const route = path.split("?")[0] ?? path;
          requestCounts.set(route, (requestCounts.get(route) ?? 0) + 1);

          const res = await fetch(`${API}/${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (res.status === 429) {
            // Every early exit must release the body, or undici holds the connection
            // until the pool is exhausted and all later requests block forever.
            await discard(res);
            return {
              retryAfter: res.headers.get("retry-after"),
            } as const;
          }

          if (!res.ok) {
            await discard(res);
            throw new TorBoxError(`${label(path)} returned ${res.status}`);
          }

          return { body: (await res.json()) as Envelope<T> } as const;
      });

      if ("retryAfter" in outcome) {
        const waitMs = beginCooldown(outcome.retryAfter);
        throw new TorBoxError(
          `rate limited for ${Math.round(waitMs / 1000)}s (${label(path)})`,
        );
      }

      const body = outcome.body;
      if (!body.success) {
        throw new TorBoxError(`${label(path)} failed: ${body.detail ?? "unknown error"}`);
      }
      consecutiveRateLimits = 0;
      return body.data ?? null;
    } catch (err) {
      if (err instanceof TorBoxError) throw err;
      throw new TorBoxError(
        `${label(path)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Confirms the API key works, so a bad key fails loudly at startup. */
  async verify(): Promise<boolean> {
    try {
      return (await this.call<{ plan?: number }>("user/me", {}, 15_000)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Which of these hashes TorBox can serve instantly. Everything else would need
   * downloading first, which is useless for a channel that has to air on schedule.
   */
  async checkCached(hashes: string[], withFiles = true): Promise<Map<string, CachedTorrent>> {
    const found = new Map<string, CachedTorrent>();
    if (hashes.length === 0) return found;

    // The hash list goes in the query string, so send it in chunks.
    for (let i = 0; i < hashes.length; i += 50) {
      const chunk = hashes.slice(i, i + 50);
      const data = await this.call<CachedTorrent[]>(
        `torrents/checkcached?hash=${chunk.join(",")}&format=list` +
          (withFiles ? "&list_files=true" : ""),
      );
      for (const item of data ?? []) {
        if (item?.hash) found.set(item.hash.toLowerCase(), item);
      }
    }
    return found;
  }

  /** Adds a torrent. For an already-cached hash this returns immediately. */
  async addMagnet(hash: string): Promise<number | null> {
    const form = new FormData();
    form.append("magnet", `magnet:?xt=urn:btih:${hash}`);
    // A race can make a previously cached torrent disappear. Never turn schedule
    // generation into an uncached download, which has a much stricter hourly quota.
    form.append("add_only_if_cached", "true");

    const data = await this.call<{ torrent_id?: number }>(
      "torrents/createtorrent",
      { method: "POST", body: form },
      60_000,
    );
    return data?.torrent_id ?? null;
  }

  /**
   * File IDs returned by checkcached describe the shared cache entry. requestdl needs
   * the IDs on the torrent just added to this user's account, whose order can differ.
   * Fetching mylist is therefore part of binding creation, not an optional diagnostic.
   */
  async torrentFiles(torrentId: number): Promise<UserTorrentFile[]> {
    const data = await this.call<UserTorrent | UserTorrent[]>(
      `torrents/mylist?id=${torrentId}&bypass_cache=true`,
    );
    const torrent = Array.isArray(data) ? data[0] : data;
    return (torrent?.files ?? [])
      .filter((file) => Number.isInteger(file.id) && Boolean(file.short_name ?? file.name))
      .map((file) => ({
        id: file.id,
        name: file.short_name ?? file.name ?? "",
        size: file.size ?? 0,
      }));
  }

  /**
   * A direct CDN link. TorBox opens these for about three hours, so the caller must
   * track expiry and re-request rather than storing one indefinitely.
   */
  async downloadLink(torrentId: number, fileId: number): Promise<string | null> {
    try {
      return await this.call<string>(
        // Unlike the rest of the API, requestdl's current schema requires token in the
        // query even when the same credential is present in the Authorization header.
        `torrents/requestdl?token=${encodeURIComponent(this.apiKey)}` +
          `&torrent_id=${torrentId}&file_id=${fileId}`,
      );
    } catch (err) {
      log.warn("requestdl failed", err instanceof Error ? err.message : err);
      return null;
    }
  }
}
