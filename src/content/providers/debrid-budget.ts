import type { Config } from "../../config.ts";
import type { Db, DebridUsage } from "../../db.ts";
import type { CachedTorrent, TorBoxApi, UserTorrentFile } from "./torbox.ts";

export class DebridBudgetExceededError extends Error {
  constructor(readonly usage: DebridUsage, amount: number) {
    const hourly = usage.hourlyUsed + amount > usage.hourlyLimit;
    const resetAt = hourly ? usage.hourlyResetAt : usage.dailyResetAt;
    super(`debrid operation budget exhausted until ${new Date(resetAt).toISOString()}`);
    this.name = "DebridBudgetExceededError";
  }
}

/**
 * Counts provider operations before they are sent. The counters are persisted in SQLite,
 * so a restart cannot be used to bypass an hourly or daily ceiling.
 */
export class BudgetedTorBoxApi implements TorBoxApi {
  constructor(
    private readonly inner: TorBoxApi,
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  status(now = Date.now()): DebridUsage {
    return this.db.debridUsage(
      this.config.debridHourlyOperationLimit,
      this.config.debridDailyOperationLimit,
      now,
    );
  }

  private reserve(amount = 1): void {
    const result = this.db.consumeDebridUsage(
      amount,
      this.config.debridHourlyOperationLimit,
      this.config.debridDailyOperationLimit,
    );
    if (!result.allowed) throw new DebridBudgetExceededError(result.usage, amount);
  }

  /** Startup credential verification is exempt so diagnostics still work at the ceiling. */
  verify(): Promise<boolean> {
    return this.inner.verify();
  }

  checkCached(hashes: string[], withFiles = true): Promise<Map<string, CachedTorrent>> {
    // TorBox accepts at most 50 hashes in one upstream request.
    if (hashes.length > 0) this.reserve(Math.ceil(hashes.length / 50));
    return this.inner.checkCached(hashes, withFiles);
  }

  addMagnet(hash: string): Promise<number | null> {
    this.reserve();
    return this.inner.addMagnet(hash);
  }

  torrentFiles(torrentId: number): Promise<UserTorrentFile[]> {
    this.reserve();
    return this.inner.torrentFiles(torrentId);
  }

  downloadLink(torrentId: number, fileId: number): Promise<string | null> {
    this.reserve();
    return this.inner.downloadLink(torrentId, fileId);
  }
}
