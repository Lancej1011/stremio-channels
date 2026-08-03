import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { channelSchema } from "../config.ts";
import { Cinemeta } from "../content/cinemeta.ts";
import type { StreamResolver } from "../content/resolver.ts";
import { openDb } from "../db.ts";
import { testConfig } from "../testing/harness.ts";
import { ScheduleGenerator } from "./generator.ts";

const root = mkdtempSync(join(tmpdir(), "schedule-preview-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const unusedResolver: StreamResolver = {
  name: "unused",
  async resolve() {
    throw new Error("a schedule preview must not resolve streams");
  },
};

describe("schedule preview", () => {
  it("uses production selection while keeping sequential episode counters in memory", async () => {
    const dataDir = join(root, "sequential");
    const db = openDb(dataDir);
    for (const [id, name] of [["tt6000001", "Alpha"], ["tt6000002", "Beta"]]) {
      db.putCached(`cinemeta:series:${id}`, {
        id,
        name,
        runtime: "30 min",
        videos: Array.from({ length: 6 }, (_, i) => ({
          season: 1,
          episode: i + 1,
          name: `${name} ${i + 1}`,
        })),
      });
    }

    const def = channelSchema.parse({
      id: "preview-sequential",
      name: "Preview Sequential",
      strategy: "sequential",
      seed: 17,
      content: [
        { type: "series", id: "tt6000001" },
        { type: "series", id: "tt6000002" },
      ],
    });
    const gen = new ScheduleGenerator(def, db, new Cinemeta(db), unusedResolver, testConfig(dataDir));
    const start = new Date(2026, 7, 2, 12, 0, 0, 0).getTime();
    const first = await gen.preview(start, start + 4 * 3600_000);
    const second = await gen.preview(start, start + 4 * 3600_000);

    assert.deepEqual(
      first.programs.map((p) => p.ref),
      second.programs.map((p) => p.ref),
      "the same seed and clock produced a different draft schedule",
    );
    for (const seriesId of ["tt6000001", "tt6000002"]) {
      const episodes = first.programs
        .filter((p) => p.ref.id === seriesId)
        .map((p) => p.ref.episode);
      assert.deepEqual(episodes, episodes.map((_, i) => i + 1));
    }
    assert.ok(first.programs.every((p) => p.durationSource === "estimated"));
    assert.equal(db.counter(def.id, "slot:default"), 0);
    assert.equal(db.programsFrom(def.id, 0, 100).length, 0);
    db.close();
  });

  it("projects a daypart crossing midnight and labels assumed runtimes", async () => {
    const dataDir = join(root, "dayparts");
    const db = openDb(dataDir);
    db.putCached("cinemeta:movie:tt6000010", {
      id: "tt6000010",
      name: "Default Movie",
      runtime: "30 min",
    });
    db.putCached("cinemeta:movie:tt6000011", {
      id: "tt6000011",
      name: "Late Movie",
    });

    const def = channelSchema.parse({
      id: "preview-daypart",
      name: "Preview Daypart",
      strategy: "shuffle",
      seed: 1,
      content: [{ type: "movie", id: "tt6000010" }],
      dayparts: [{
        name: "Late",
        start: "23:00",
        end: "01:00",
        content: [{ type: "movie", id: "tt6000011" }],
      }],
    });
    const gen = new ScheduleGenerator(def, db, new Cinemeta(db), unusedResolver, testConfig(dataDir));
    const start = new Date(2026, 7, 2, 23, 30, 0, 0).getTime();
    const preview = await gen.preview(start, start + 2 * 3600_000);

    assert.deepEqual(preview.programs.map((p) => p.daypart), ["Late", "Late", "Late", null]);
    assert.deepEqual(
      preview.programs.map((p) => p.title),
      ["Late Movie", "Late Movie", "Late Movie", "Default Movie"],
    );
    assert.equal(preview.programs[0]?.durationSource, "assumed");
    assert.match(preview.warnings.join(" "), /30-minute estimates/);
    db.close();
  });
});
