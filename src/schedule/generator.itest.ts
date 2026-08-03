/**
 * Integration tests for schedule generation against a real database.
 *
 * These reproduce two bugs that were found by hand and would otherwise have no cover:
 * an episode counter consumed by a selection that was then discarded, and two
 * generators appending to one channel's timeline.
 *
 * Nothing here touches the network. Cinemeta is served from its own SQLite cache, and
 * the resolver is a stub pointing at a local file, so what is exercised is the
 * generator's own logic: batch selection, daypart truncation, and disposal.
 *
 * Run with `npm run test:integration`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { channelSchema, type ChannelDef } from "../config.ts";
import { Cinemeta } from "../content/cinemeta.ts";
import type { PreparatoryResolver, ResolvedStream, StreamResolver } from "../content/resolver.ts";
import { openDb, type Db } from "../db.ts";
import { makeClip, recordingLogger, sleep, testConfig } from "../testing/harness.ts";
import { ScheduleGenerator } from "./generator.ts";

const SERIES = "tt9000001";
const EPISODES = 24;
/** Real duration of the synthetic source every episode resolves to. */
const EPISODE_MS = 5 * 60_000;

const root = mkdtempSync(join(tmpdir(), "chan-gen-itest-"));
let clip = "";

before(async () => {
  // A five minute clip encoded as one frame every two seconds: ffprobe reports the
  // duration the generator needs, and it costs almost nothing to produce.
  clip = await makeClip(join(root, "episode.mp4"), {
    seconds: EPISODE_MS / 1000,
    silent: true,
    source: "color=c=black:size=64x48:rate=0.5",
  });
}, { timeout: 120_000 });

after(() => rmSync(root, { recursive: true, force: true }));

/** Pre-loads Cinemeta's own cache so `expand` and `titleInfo` never reach the network. */
function seedCinemeta(db: Db): void {
  db.putCached(`cinemeta:series:${SERIES}`, {
    id: SERIES,
    name: "Test Series",
    runtime: "5 min",
    videos: Array.from({ length: EPISODES }, (_, i) => ({
      season: 1,
      episode: i + 1,
      name: `Episode ${i + 1}`,
    })),
  });
}

function stubResolver(delayMs = 0): StreamResolver {
  return {
    name: "stub",
    async resolve(): Promise<ResolvedStream | null> {
      if (delayMs) await sleep(delayMs);
      return { url: clip, expiresAt: Date.now() + 3600_000, label: "stub" };
    },
  };
}

/** `HH:MM` for a wall-clock time this many minutes from now, wrapping past midnight. */
function clockOffset(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function channel(overrides: Partial<ChannelDef> = {}): ChannelDef {
  return channelSchema.parse({
    id: "gen",
    name: "Generator Test",
    strategy: "sequential",
    seed: 1,
    content: [{ type: "series", id: SERIES }],
    ...overrides,
  });
}

/** Episode numbers actually written to the timeline, in the order they air. */
function airedEpisodes(db: Db, channelId: string): number[] {
  return db
    .programsFrom(channelId, 0, 1000)
    .map((p) => Number(p.ref_key.split(":")[2]));
}

describe("schedule generation", { timeout: 180_000 }, () => {
  it("defers a download URL when durable ids and a measured runtime are already cached", async () => {
    const dataDir = join(root, "deferred-url");
    const db = openDb(dataDir);
    const movie = "tt5000200";
    db.putCached(`cinemeta:movie:${movie}`, { id: movie, name: "Prepared Movie", runtime: "5 min" });
    db.putProbe({ ref_key: movie, duration_ms: EPISODE_MS, video_codec: "h264", audio_codec: null, probed_at: Date.now() });
    const needUrl: boolean[] = [];
    const resolver: PreparatoryResolver = {
      name: "prepared",
      async prepare(_ref, required) {
        needUrl.push(required);
        return { url: null, expiresAt: null, torrentId: 91, fileId: 7, label: "cached binding" };
      },
      async refresh() {
        return { url: clip, expiresAt: Date.now() + 3600_000, torrentId: 91, fileId: 7, label: "fresh" };
      },
      async resolve() {
        throw new Error("resolve should not be needed for a prepared slot");
      },
    };
    const config = testConfig(dataDir, { scheduleHorizonHours: 0.01 });
    const def = channelSchema.parse({ id: "prepared", name: "Prepared", content: [{ type: "movie", id: movie }] });
    const gen = new ScheduleGenerator(def, db, new Cinemeta(db), resolver, config);
    await gen.ensureHorizon();

    const program = db.programsFrom("prepared", 0, 1)[0];
    assert.ok(program);
    assert.ok(needUrl.length > 0);
    assert.ok(needUrl.every((required) => required === false));
    assert.equal(program.resolved_url, null);
    assert.equal(program.torrent_id, 91);
    assert.equal(program.file_id, 7);
    assert.equal(await gen.freshUrl(program), clip);
    db.close();
  });

  it("does not consume an episode counter for a selection it discards", async () => {
    const dataDir = join(root, "counters");
    const db = openDb(dataDir);
    seedCinemeta(db);

    // Half an hour of horizon: six five-minute episodes, reached in two batches.
    const config = testConfig(dataDir, { scheduleHorizonHours: 0.5 });
    const recorder = recordingLogger();

    // A daypart starting fifteen minutes from now. The generator selects a batch against
    // an *estimated* clock that assumes thirty minutes per program, so on the first pass
    // — before anything has been probed — everything after the first slot is picked for
    // this block, while the real five-minute durations leave it still in the default one.
    // Those picks are thrown away, and that is the moment the bug used to strike.
    const def = channel({
      dayparts: [
        { name: "Late", start: clockOffset(15), end: clockOffset(180) },
      ],
    });

    const gen = new ScheduleGenerator(
      def,
      db,
      new Cinemeta(db),
      stubResolver(),
      config,
      recorder.log,
    );
    await gen.ensureHorizon();

    // If this did not happen the test proves nothing, so assert it explicitly.
    assert.ok(
      recorder.matching(/batch truncated at a daypart boundary/).length > 0,
      `no batch was truncated, so the discard path never ran:\n${recorder.lines.join("\n")}`,
    );

    const episodes = airedEpisodes(db, "gen");
    assert.ok(episodes.length >= 6, `only ${episodes.length} programs were scheduled`);

    // The bug, exactly: the discarded picks bumped the counter, so the schedule jumped
    // from episode 1 straight to episode 7 and five episodes never aired.
    assert.deepEqual(
      episodes,
      Array.from({ length: episodes.length }, (_, i) => i + 1),
      "a sequential channel skipped episodes across a truncated batch",
    );

    // Same invariant read from the other side: one counter bump per program that aired.
    assert.equal(
      db.counter("gen", `ep:${SERIES}`),
      episodes.length,
      "the episode counter and the timeline disagree about how many episodes aired",
    );

    db.close();
  });

  it("keeps the timeline contiguous when a batch straddles a daypart boundary", async () => {
    const dataDir = join(root, "contiguous");
    const db = openDb(dataDir);
    seedCinemeta(db);
    const config = testConfig(dataDir, { scheduleHorizonHours: 0.5 });

    const def = channel({
      dayparts: [{ name: "Late", start: clockOffset(15), end: clockOffset(180) }],
    });
    const gen = new ScheduleGenerator(def, db, new Cinemeta(db), stubResolver(), config);
    await gen.ensureHorizon();

    const programs = db.programsFrom("gen", 0, 1000);
    assert.ok(programs.length >= 6);
    for (let i = 1; i < programs.length; i++) {
      // A gap is dead air the guide claims is programming; an overlap means the guide
      // and the screen disagree. Neither is survivable for a clock-synced channel.
      assert.equal(
        programs[i]!.start_ms,
        programs[i - 1]!.start_ms + programs[i - 1]!.duration_ms,
        `programs ${i - 1} and ${i} are not contiguous`,
      );
    }

    // Truncation must not leave holes in the slot sequence either, or a later pass
    // re-selects against a slot index that has already aired.
    assert.deepEqual(
      programs.map((p) => p.slot_index),
      programs.map((_, i) => i),
    );

    db.close();
  });

  it("stops a disposed generator from appending alongside its replacement", async () => {
    const dataDir = join(root, "dispose");
    const db = openDb(dataDir);
    seedCinemeta(db);
    const config = testConfig(dataDir, { scheduleHorizonHours: 1 });
    const recorder = recordingLogger();

    // Slow enough that the first batch is still resolving when the reload lands, which
    // is the window the real bug lived in: a channel edited while its schedule was
    // being built.
    const outgoing = new ScheduleGenerator(
      channel(),
      db,
      new Cinemeta(db),
      stubResolver(1200),
      config,
      recorder.log,
    );
    const outgoingPass = outgoing.ensureHorizon();

    await sleep(300);
    outgoing.dispose();

    // The replacement reads the same timeline end the outgoing one did.
    const incoming = new ScheduleGenerator(
      channel(),
      db,
      new Cinemeta(db),
      stubResolver(),
      config,
      recorder.log,
    );
    await incoming.ensureHorizon();
    await outgoingPass;
    // Give anything still in flight on the outgoing generator a chance to misbehave.
    await sleep(2000);

    const programs = db.programsFrom("gen", 0, 1000);
    assert.ok(programs.length > 0, "the replacement generator scheduled nothing");

    // Two generators appending to one timeline both start from the same end point, so
    // the symptom is duplicated slot indices and programs sitting on top of each other.
    const slots = programs.map((p) => p.slot_index);
    assert.equal(
      new Set(slots).size,
      slots.length,
      `duplicate slot indices: ${slots.join(", ")}`,
    );
    for (let i = 1; i < programs.length; i++) {
      assert.equal(
        programs[i]!.start_ms,
        programs[i - 1]!.start_ms + programs[i - 1]!.duration_ms,
        "two generators overlapped on the timeline",
      );
    }

    // Episodes must not double up either: both generators walking the same counter is
    // how the same programme ended up airing twice.
    const episodes = airedEpisodes(db, "gen");
    assert.equal(
      new Set(episodes).size,
      episodes.length,
      `an episode was scheduled twice: ${episodes.join(", ")}`,
    );

    db.close();
  });

  it("leaves the timeline alone when a generator is disposed before it writes", async () => {
    const dataDir = join(root, "dispose-early");
    const db = openDb(dataDir);
    seedCinemeta(db);
    const config = testConfig(dataDir, { scheduleHorizonHours: 1 });

    const gen = new ScheduleGenerator(
      channel(),
      db,
      new Cinemeta(db),
      stubResolver(1200),
      config,
    );
    const pass = gen.ensureHorizon();
    await sleep(300);
    gen.dispose();
    await pass;
    await sleep(2000);

    assert.equal(
      db.programsFrom("gen", 0, 1000).length,
      0,
      "a generator disposed mid-batch still wrote its results",
    );
    assert.equal(
      db.counter("gen", `ep:${SERIES}`),
      0,
      "a generator disposed mid-batch still advanced the episode counter",
    );

    db.close();
  });
});
