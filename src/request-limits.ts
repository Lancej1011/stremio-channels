import type { IncomingMessage } from "node:http";

export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  blockedUntil: number;
  touchedAt: number;
}

/** A bounded, in-memory per-client limiter for network abuse controls. */
export class ClientRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly blockMs = windowMs,
    private readonly maxClients = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): LimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs, blockedUntil: 0, touchedAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.touchedAt = now;
    if (now < bucket.blockedUntil) {
      return { allowed: false, retryAfterSeconds: seconds(bucket.blockedUntil - now) };
    }
    bucket.count++;
    if (bucket.count > this.limit) {
      bucket.blockedUntil = now + this.blockMs;
      this.evictIfNeeded();
      return { allowed: false, retryAfterSeconds: seconds(this.blockMs) };
    }
    this.evictIfNeeded();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private evictIfNeeded(): void {
    if (this.buckets.size <= this.maxClients) return;
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestKey = key;
        oldestAt = bucket.touchedAt;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

/** Socket address only: forwarding headers are attacker-controlled on direct requests. */
export function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
