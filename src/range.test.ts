import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentRange, parseRange, rangeLength } from "./range.ts";

const SIZE = 1000;

describe("parseRange", () => {
  it("reads a fully specified range with inclusive bounds", () => {
    const range = parseRange("bytes=100-199", SIZE);
    assert.deepEqual(range, { start: 100, end: 199 });
    // The classic off-by-one: 100..199 inclusive is 100 bytes, not 99.
    assert.equal(rangeLength(range as { start: number; end: number }), 100);
  });

  it("reads an open-ended range as running to the last byte", () => {
    // This is the form ExoPlayer sends on a retry.
    assert.deepEqual(parseRange("bytes=0-", SIZE), { start: 0, end: 999 });
    assert.deepEqual(parseRange("bytes=500-", SIZE), { start: 500, end: 999 });
  });

  it("reads a suffix range as the last N bytes", () => {
    assert.deepEqual(parseRange("bytes=-500", SIZE), { start: 500, end: 999 });
  });

  it("clamps a suffix longer than the file to the whole file", () => {
    assert.deepEqual(parseRange("bytes=-5000", SIZE), { start: 0, end: 999 });
  });

  it("clamps an end past the file rather than rejecting it", () => {
    // Clients legitimately ask for more than exists; answering with what there is beats
    // a 416 the player has to recover from.
    assert.deepEqual(parseRange("bytes=900-5000", SIZE), { start: 900, end: 999 });
  });

  it("rejects a start at or past the end of the file", () => {
    assert.equal(parseRange("bytes=1000-", SIZE), "unsatisfiable");
    assert.equal(parseRange("bytes=1001-2000", SIZE), "unsatisfiable");
  });

  it("rejects a zero-length suffix", () => {
    assert.equal(parseRange("bytes=-0", SIZE), "unsatisfiable");
  });

  it("treats an empty file as unable to satisfy anything", () => {
    assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  });

  it("falls back to the whole file when there is no range to honour", () => {
    // null means "answer 200 with everything", which is always legal.
    assert.equal(parseRange(undefined, SIZE), null);
    assert.equal(parseRange("", SIZE), null);
  });

  it("falls back to the whole file for a multipart range", () => {
    // Answering these properly needs a multipart/byteranges body; no player asks for it.
    assert.equal(parseRange("bytes=0-1,5-6", SIZE), null);
  });

  it("falls back to the whole file for malformed or unsupported headers", () => {
    assert.equal(parseRange("items=0-10", SIZE), null);
    assert.equal(parseRange("bytes=abc-def", SIZE), null);
    assert.equal(parseRange("bytes=", SIZE), null);
    assert.equal(parseRange("bytes=-", SIZE), null);
    assert.equal(parseRange("garbage", SIZE), null);
  });

  it("ignores a backwards range rather than calling it unsatisfiable", () => {
    assert.equal(parseRange("bytes=500-100", SIZE), null);
  });

  it("accepts the header case-insensitively and with stray whitespace", () => {
    assert.deepEqual(parseRange(" BYTES=0-99 ", SIZE), { start: 0, end: 99 });
  });

  it("handles a single-byte range", () => {
    const range = parseRange("bytes=0-0", SIZE);
    assert.deepEqual(range, { start: 0, end: 0 });
    assert.equal(rangeLength(range as { start: number; end: number }), 1);
  });
});

describe("contentRange", () => {
  it("formats the header with inclusive bounds and the total size", () => {
    assert.equal(contentRange({ start: 0, end: 99 }, SIZE), "bytes 0-99/1000");
    assert.equal(contentRange({ start: 500, end: 999 }, SIZE), "bytes 500-999/1000");
  });
});
