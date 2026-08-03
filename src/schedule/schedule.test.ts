import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { refKey, type ContentRef } from "../config.ts";
import { openDb } from "../db.ts";
import { getGuide, getNowPlaying } from "./clock.ts";
import { hashSeed, pickForSlot, seededShuffle } from "./strategies/shuffle.ts";

const pool: ContentRef[] = [
  { type: "movie", id: "tt0001" },
  { type: "movie", id: "tt0002" },
  { type: "movie", id: "tt0003" },
  { type: "series", id: "tt0100", season: 1, episode: 1 },
  { type: "series", id: "tt0100", season: 1, episode: 2 },
];

describe("seededShuffle", () => {
  it("is reproducible for the same seed", () => {
    assert.deepEqual(seededShuffle(pool, 42), seededShuffle(pool, 42));
  });

  it("produces a different order for a different seed", () => {
    const a = seededShuffle(pool, 1).map(refKey).join();
    const b = seededShuffle(pool, 999).map(refKey).join();
    assert.notEqual(a, b);
  });

  it("keeps every element exactly once", () => {
    const shuffled = seededShuffle(pool, 7).map(refKey).sort();
    assert.deepEqual(shuffled, pool.map(refKey).sort());
  });
});

describe("pickForSlot", () => {
  it("returns the same program for the same slot every time", () => {
    for (let slot = 0; slot < 20; slot++) {
      assert.equal(refKey(pickForSlot(pool, 5, slot)), refKey(pickForSlot(pool, 5, slot)));
    }
  });

  it("airs everything once before repeating anything", () => {
    const cycle = Array.from({ length: pool.length }, (_, i) => refKey(pickForSlot(pool, 3, i)));
    assert.equal(new Set(cycle).size, pool.length, "a title repeated within one cycle");
  });

  it("holds the no-repeat guarantee across many cycles", () => {
    for (let cycle = 0; cycle < 50; cycle++) {
      const slots = Array.from({ length: pool.length }, (_, i) =>
        refKey(pickForSlot(pool, 11, cycle * pool.length + i)),
      );
      assert.equal(new Set(slots).size, pool.length, `repeat inside cycle ${cycle}`);
    }
  });

  it("reshuffles between cycles rather than looping the same order", () => {
    const first = Array.from({ length: pool.length }, (_, i) => refKey(pickForSlot(pool, 3, i)));
    const orders = new Set<string>();
    for (let cycle = 0; cycle < 12; cycle++) {
      orders.add(
        Array.from({ length: pool.length }, (_, i) =>
          refKey(pickForSlot(pool, 3, cycle * pool.length + i)),
        ).join(),
      );
    }
    assert.ok(orders.size > 1, "every cycle used the identical order");
    assert.equal(orders.has(first.join()), true);
  });

  it("does not depend on the order content is listed in", () => {
    const reversed = pool.slice().reverse();
    for (let slot = 0; slot < 15; slot++) {
      assert.equal(
        refKey(pickForSlot(pool, 8, slot)),
        refKey(pickForSlot(reversed, 8, slot)),
        "pool ordering leaked into the schedule",
      );
    }
  });

  it("rejects an empty pool instead of silently airing nothing", () => {
    assert.throws(() => pickForSlot([], 1, 0), /empty pool/);
  });
});

describe("hashSeed", () => {
  it("separates arguments so different parts cannot collide", () => {
    assert.notEqual(hashSeed("ab", "c"), hashSeed("a", "bc"));
  });
});

describe("counters", () => {
  const dir = mkdtempSync(join(tmpdir(), "chan-counter-"));
  const db = openDb(dir);
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at zero and returns the value before incrementing", () => {
    // Sequential playback depends on this: the first airing must be episode index 0.
    assert.equal(db.nextCounter("c", "ep:tt1"), 0);
    assert.equal(db.nextCounter("c", "ep:tt1"), 1);
    assert.equal(db.nextCounter("c", "ep:tt1"), 2);
  });

  it("tracks each series independently", () => {
    db.nextCounter("c", "ep:ttA");
    db.nextCounter("c", "ep:ttA");
    assert.equal(db.nextCounter("c", "ep:ttB"), 0, "a second series inherited progress");
    assert.equal(db.nextCounter("c", "ep:ttA"), 2);
  });

  it("keeps channels separate", () => {
    db.nextCounter("one", "ep:ttX");
    assert.equal(db.nextCounter("two", "ep:ttX"), 0);
  });

  it("reads without advancing", () => {
    db.nextCounter("peek", "k");
    assert.equal(db.counter("peek", "k"), 1);
    assert.equal(db.counter("peek", "k"), 1);
  });

  it("survives being read back, which is what makes progress restart-safe", () => {
    for (let i = 0; i < 5; i++) db.nextCounter("persist", "ep:ttP");
    assert.equal(db.counter("persist", "ep:ttP"), 5);
  });

  it("resets a channel without touching others", () => {
    db.nextCounter("keep", "k");
    db.nextCounter("drop", "k");
    db.clearCounters("drop");
    assert.equal(db.counter("drop", "k"), 0);
    assert.equal(db.counter("keep", "k"), 1);
  });
});

describe("clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "chan-test-"));
  const db = openDb(dir);
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const T0 = 1_700_000_000_000;
  db.insertPrograms([
    { channel_id: "c1", slot_index: 0, start_ms: T0, duration_ms: 60_000, ref_key: "tt1", title: "First", resolved_url: "u1", url_expires_at: null, daypart: null, torrent_id: null, file_id: null },
    { channel_id: "c1", slot_index: 1, start_ms: T0 + 60_000, duration_ms: 120_000, ref_key: "tt2", title: "Second", resolved_url: "u2", url_expires_at: null, daypart: null, torrent_id: null, file_id: null },
    { channel_id: "c1", slot_index: 2, start_ms: T0 + 180_000, duration_ms: 60_000, ref_key: "tt3", title: "Third", resolved_url: "u3", url_expires_at: null, daypart: null, torrent_id: null, file_id: null },
  ]);

  it("reports the offset for a mid-program tune-in", () => {
    const now = getNowPlaying(db, "c1", T0 + 90_000);
    assert.equal(now?.program.title, "Second");
    assert.equal(now?.offsetMs, 30_000);
    assert.equal(now?.remainingMs, 90_000);
  });

  it("treats a slot as inclusive of its start and exclusive of its end", () => {
    assert.equal(getNowPlaying(db, "c1", T0)?.program.title, "First");
    // The boundary belongs to the next program, so no slot is ever double-booked.
    assert.equal(getNowPlaying(db, "c1", T0 + 60_000)?.program.title, "Second");
    assert.equal(getNowPlaying(db, "c1", T0 + 59_999)?.program.title, "First");
  });

  it("returns null outside the generated timeline", () => {
    assert.equal(getNowPlaying(db, "c1", T0 - 1), null);
    assert.equal(getNowPlaying(db, "c1", T0 + 240_000), null);
    assert.equal(getNowPlaying(db, "nope", T0 + 1000), null);
  });

  it("builds a guide starting from what is on now", () => {
    const guide = getGuide(db, "c1", T0 + 90_000, 5);
    assert.deepEqual(guide.map((g) => g.program.title), ["Second", "Third"]);
    assert.equal(guide[0]?.isNow, true);
    assert.equal(guide[1]?.isNow, false);
  });
});
