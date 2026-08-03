import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refKey, type ContentRef } from "../../config.ts";
import { advancesEpisodes, expandByWeight, pickWeighted, pickerFor } from "./index.ts";

const titles: ContentRef[] = [
  { type: "series", id: "tt0001" },
  { type: "series", id: "tt0002" },
  { type: "movie", id: "tt0003" },
];

describe("expandByWeight", () => {
  it("repeats an entry once per unit of weight", () => {
    const expanded = expandByWeight([
      { type: "movie", id: "tt0001", weight: 3 },
      { type: "movie", id: "tt0002" },
    ]);
    assert.equal(expanded.length, 4);
    assert.equal(expanded.filter((e) => e.id === "tt0001").length, 3);
    assert.equal(expanded.filter((e) => e.id === "tt0002").length, 1);
  });

  it("treats a missing weight as 1", () => {
    assert.equal(expandByWeight(titles).length, titles.length);
  });

  it("never drops an entry with a fractional weight", () => {
    // Rounding down would silently remove content the user explicitly listed.
    const expanded = expandByWeight([{ type: "movie", id: "tt0001", weight: 0.2 }]);
    assert.equal(expanded.length, 1);
  });
});

describe("pickWeighted", () => {
  it("is reproducible for the same seed and slot", () => {
    for (let slot = 0; slot < 20; slot++) {
      assert.equal(
        refKey(pickWeighted(titles, 7, slot)),
        refKey(pickWeighted(titles, 7, slot)),
      );
    }
  });

  it("respects the configured ratio over many slots", () => {
    const weighted: ContentRef[] = [
      { type: "series", id: "tt0001", weight: 3 },
      { type: "series", id: "tt0002", weight: 1 },
    ];

    const counts = new Map<string, number>();
    for (let slot = 0; slot < 800; slot++) {
      const id = pickWeighted(weighted, 5, slot).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const ratio = (counts.get("tt0001") ?? 0) / (counts.get("tt0002") ?? 1);
    assert.ok(ratio > 2.7 && ratio < 3.3, `expected about 3:1, got ${ratio.toFixed(2)}:1`);
  });

  it("still airs everything within a cycle", () => {
    const weighted: ContentRef[] = [
      { type: "series", id: "tt0001", weight: 2 },
      { type: "series", id: "tt0002" },
      { type: "movie", id: "tt0003" },
    ];
    // Cycle length is the sum of weights, not the number of entries.
    const cycle = Array.from({ length: 4 }, (_, i) => pickWeighted(weighted, 9, i).id);
    assert.deepEqual(new Set(cycle), new Set(["tt0001", "tt0002", "tt0003"]));
    assert.equal(cycle.filter((id) => id === "tt0001").length, 2);
  });

  it("behaves like a plain shuffle when all weights are equal", () => {
    const cycle = Array.from({ length: 3 }, (_, i) => pickWeighted(titles, 4, i).id);
    assert.equal(new Set(cycle).size, 3, "a title repeated inside one cycle");
  });
});

describe("pickerFor", () => {
  it("gives every strategy a working picker", () => {
    for (const strategy of ["shuffle", "sequential", "weighted"] as const) {
      const pick = pickerFor(strategy);
      assert.ok(pick(titles, 1, 0), `${strategy} produced nothing`);
    }
  });

  it("picks titles the same way for shuffle and sequential", () => {
    // They differ in which *episode* airs, not in which show is chosen.
    for (let slot = 0; slot < 10; slot++) {
      assert.equal(
        refKey(pickerFor("shuffle")(titles, 3, slot)),
        refKey(pickerFor("sequential")(titles, 3, slot)),
      );
    }
  });
});

describe("advancesEpisodes", () => {
  it("is true only for sequential", () => {
    assert.equal(advancesEpisodes("sequential"), true);
    assert.equal(advancesEpisodes("shuffle"), false);
    assert.equal(advancesEpisodes("weighted"), false);
  });
});
