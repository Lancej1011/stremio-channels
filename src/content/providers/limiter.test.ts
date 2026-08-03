import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cooldownRemainingSeconds,
  RateLimiter,
  resetRateLimitState,
  retryAfterMs,
  TorBoxClient,
  withTimeout,
} from "./torbox.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RateLimiter", () => {
  it("runs every task even when far more are queued than can run at once", async () => {
    // The original implementation lost a wakeup here and the last task hung forever.
    const limiter = new RateLimiter({ maxInFlight: 2, minGapMs: 0 });
    const done: number[] = [];

    await withTimeout(
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          limiter.run(async () => {
            await sleep(Math.random() * 10);
            done.push(i);
          }),
        ),
      ),
      5000,
    );

    assert.equal(done.length, 20, "some tasks never ran");
    assert.deepEqual(done.slice().sort((a, b) => a - b), [...Array(20).keys()]);
  });

  it("never exceeds the concurrency limit", async () => {
    const limiter = new RateLimiter({ maxInFlight: 3, minGapMs: 0 });
    let current = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 30 }, () =>
        limiter.run(async () => {
          current++;
          peak = Math.max(peak, current);
          await sleep(5);
          current--;
        }),
      ),
    );

    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  it("keeps running after a task throws, rather than leaking its permit", async () => {
    const limiter = new RateLimiter({ maxInFlight: 1, minGapMs: 0 });

    await assert.rejects(limiter.run(async () => { throw new Error("boom"); }));
    // If the failed task's permit leaked, this would never resolve.
    const result = await withTimeout(limiter.run(async () => "ok"), 2000);
    assert.equal(result, "ok");
  });

  it("releases the permit when a task exceeds the watchdog", async () => {
    const limiter = new RateLimiter({ maxInFlight: 1, minGapMs: 0, watchdogMs: 100 });

    await assert.rejects(limiter.run(() => new Promise(() => {})), /timed out/);
    const result = await withTimeout(limiter.run(async () => "recovered"), 2000);
    assert.equal(result, "recovered");
  });

  it("paces tasks by the configured minimum gap", async () => {
    const limiter = new RateLimiter({ maxInFlight: 4, minGapMs: 50 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => limiter.run(async () => {})));
    // Four tasks with a 50ms gap cannot all start before ~150ms have passed.
    assert.ok(Date.now() - started >= 140, "tasks were not paced");
  });
});

describe("withTimeout", () => {
  it("passes through a value that arrives in time", async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 1000), 42);
  });

  it("rejects when the promise never settles", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 50), /timed out/);
  });
});

describe("TorBox rate-limit handling", () => {
  it("parses both Retry-After formats", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    assert.equal(retryAfterMs("12", now), 12_000);
    assert.equal(retryAfterMs("Mon, 03 Aug 2026 00:00:30 GMT", now), 30_000);
    assert.equal(retryAfterMs("nonsense", now), null);
  });

  it("marks torrent creation as cached-only", async () => {
    resetRateLimitState();
    const original = globalThis.fetch;
    let form: FormData | undefined;
    globalThis.fetch = async (_input, init) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ success: true, data: { torrent_id: 42 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      assert.equal(await new TorBoxClient("test").addMagnet("abc"), 42);
      assert.equal(form?.get("add_only_if_cached"), "true");
    } finally {
      globalThis.fetch = original;
      resetRateLimitState();
    }
  });

  it("reads requestdl file ids from the user's torrent rather than the cache entry", async () => {
    resetRateLimitState();
    const original = globalThis.fetch;
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({
        success: true,
        data: {
          id: 42,
          files: [{ id: 17, name: "folder/episode.mkv", short_name: "episode.mkv", size: 123 }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      assert.deepEqual(await new TorBoxClient("test").torrentFiles(42), [
        { id: 17, name: "episode.mkv", size: 123 },
      ]);
      assert.match(requested, /torrents\/mylist\?id=42&bypass_cache=true$/);
    } finally {
      globalThis.fetch = original;
      resetRateLimitState();
    }
  });

  it("turns a requestdl 429 into a shared cooldown", async () => {
    resetRateLimitState();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } });
    try {
      assert.equal(await new TorBoxClient("test").downloadLink(1, 2), null);
      assert.ok(cooldownRemainingSeconds() >= 1);
    } finally {
      globalThis.fetch = original;
      resetRateLimitState();
    }
  });

  it("sends the token query parameter required by requestdl", async () => {
    resetRateLimitState();
    const original = globalThis.fetch;
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ success: true, data: "https://cdn.example/file" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      assert.equal(
        await new TorBoxClient("a token/with spaces").downloadLink(7, 3),
        "https://cdn.example/file",
      );
      assert.match(requested, /requestdl\?token=a%20token%2Fwith%20spaces&torrent_id=7&file_id=3$/);
    } finally {
      globalThis.fetch = original;
      resetRateLimitState();
    }
  });
});
