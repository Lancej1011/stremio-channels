import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientRateLimiter } from "./request-limits.ts";

describe("per-client request limiter", () => {
  it("blocks only the client that exceeds its window and later resets", () => {
    let now = 1_000;
    const limiter = new ClientRateLimiter(2, 10_000, 20_000, 100, () => now);
    assert.equal(limiter.hit("one").allowed, true);
    assert.equal(limiter.hit("one").allowed, true);
    const blocked = limiter.hit("one");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 20);
    assert.equal(limiter.hit("two").allowed, true);

    now += 20_001;
    assert.equal(limiter.hit("one").allowed, true);
  });

  it("allows successful authentication to clear a failure bucket", () => {
    const limiter = new ClientRateLimiter(1, 60_000);
    assert.equal(limiter.hit("one").allowed, true);
    assert.equal(limiter.hit("one").allowed, false);
    limiter.reset("one");
    assert.equal(limiter.hit("one").allowed, true);
  });
});
