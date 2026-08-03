/**
 * Integration tests for the whole tune-in path: timeline → clock → feed.
 *
 * The property under test is the one the project rests on — a channel is a function of
 * wall-clock time, not of a process staying alive — so these drive `ChannelService`
 * with a real database and real ffmpeg, and check where playback actually lands.
 *
 * Run with `npm run test:integration`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ChannelService } from "./channels.ts";
import { channelSchema, type ChannelDef } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { makeClip, recordingLogger, sleep, testConfig } from "./testing/harness.ts";

const PROGRAM_MS = 120_000;
const root = mkdtempSync(join(tmpdir(), "chan-service-itest-"));
let clip = "";

before(async () => {
  clip = await makeClip(join(root, "program.mp4"), { seconds: 150 });
}, { timeout: 120_000 });

after(() => rmSync(root, { recursive: true, force: true }));

function channel(id: string, imdb: string): ChannelDef {
  return channelSchema.parse({
    id,
    name: id,
    seed: 1,
    content: [{ type: "movie", id: imdb }],
  });
}

/**
 * Puts one already-airing program on a channel's timeline, with a link that has not
 * expired. Generation is then a no-op, so the test measures the tune-in path and not
 * the scheduler.
 */
function seedProgram(db: Db, channelId: string, imdb: string, startMs: number): void {
  db.insertPrograms([
    {
      channel_id: channelId,
      slot_index: 0,
      start_ms: startMs,
      duration_ms: PROGRAM_MS,
      ref_key: imdb,
      title: `Program on ${channelId}`,
      resolved_url: clip,
      url_expires_at: Date.now() + 3600_000,
      daypart: null,
      torrent_id: null,
      file_id: null,
    },
  ]);
  db.putProbe({
    ref_key: imdb,
    duration_ms: PROGRAM_MS,
    video_codec: "h264",
    audio_codec: "aac",
    probed_at: Date.now(),
  });
}

/** Parses the supervisor's own duration formatting: `40s`, `4m20s`. */
function parseDuration(text: string): number {
  const withMinutes = /^(\d+)m(\d+)s$/.exec(text);
  if (withMinutes) return Number(withMinutes[1]) * 60 + Number(withMinutes[2]);
  const seconds = /^(\d+)s$/.exec(text);
  assert.ok(seconds, `unparseable duration: ${text}`);
  return Number(seconds[1]);
}

const AIRING = /airing "([^"]+)" from (\S+) for (\S+)/;

describe("tune-in", { timeout: 180_000 }, () => {
  it("joins mid-program and resumes at the wall-clock offset after an idle shutdown", async () => {
    const dataDir = join(root, "resume");
    const db = openDb(dataDir);
    // Nothing left to generate, so no network call and no resolver is ever needed.
    const config = testConfig(dataDir, { scheduleHorizonHours: 0.01 });
    const recorder = recordingLogger();

    const startMs = Date.now() - 40_000;
    seedProgram(db, "resume", "tt5000001", startMs);

    const service = new ChannelService([channel("resume", "tt5000001")], db, config, recorder.log);

    // First tune-in: forty seconds into a two minute program, exactly like turning a
    // television on part-way through.
    const feed = await service.feeds.claim("resume");
    const firstLine = await recorder.waitFor(AIRING, 60_000);
    const firstAt = Date.now();
    const first = AIRING.exec(firstLine)!;

    const firstOffset = parseDuration(first[2]!);
    const expectedFirst = (firstAt - startMs) / 1000;
    assert.ok(
      Math.abs(firstOffset - expectedFirst) <= 2,
      `joined at ${firstOffset}s, expected about ${expectedFirst.toFixed(1)}s`,
    );
    // The encoder is asked for the rest of the slot, not the whole runtime, or the
    // channel would run over and every later program would start late.
    assert.ok(
      Math.abs(parseDuration(first[3]!) - (PROGRAM_MS / 1000 - expectedFirst)) <= 2,
      `asked for ${first[3]} of a program with ${(PROGRAM_MS / 1000 - expectedFirst).toFixed(0)}s left`,
    );

    await sleep(4000);
    assert.equal(feed.isRunning, true);

    // The viewer walks away and the pipeline is torn down. The channel is conceptually
    // still on air; it just costs nothing.
    feed.stop("nobody watching");
    await sleep(12_000);
    assert.equal(feed.isRunning, false);

    // Tuning back in must land where the clock is now, not where playback stopped.
    const before = recorder.matching(AIRING).length;
    await service.feeds.claim("resume");
    await recorder.waitFor(/feed started/, 60_000);
    while (recorder.matching(AIRING).length === before) await sleep(200);
    const secondAt = Date.now();
    const second = AIRING.exec(recorder.matching(AIRING).at(-1)!)!;

    const secondOffset = parseDuration(second[2]!);
    const expectedSecond = (secondAt - startMs) / 1000;
    assert.ok(
      Math.abs(secondOffset - expectedSecond) <= 3,
      `resumed at ${secondOffset}s, expected about ${expectedSecond.toFixed(1)}s`,
    );
    // The whole point: the sixteen seconds spent off air still elapsed on the channel.
    assert.ok(
      secondOffset - firstOffset >= 12,
      `the channel only advanced ${secondOffset - firstOffset}s while it was off air, ` +
        "so it resumed where playback stopped rather than where the clock is",
    );

    service.feeds.stopAll("test complete");
    await sleep(500);
    db.close();
  });

  it("does not disturb a channel that is playing when another is reconfigured", async () => {
    const dataDir = join(root, "reload");
    const db = openDb(dataDir);
    const config = testConfig(dataDir, { scheduleHorizonHours: 0.01 });
    const recorder = recordingLogger();

    const startMs = Date.now() - 10_000;
    seedProgram(db, "edited", "tt5000002", startMs);
    seedProgram(db, "watched", "tt5000003", startMs);

    const service = new ChannelService(
      [channel("edited", "tt5000002"), channel("watched", "tt5000003")],
      db,
      config,
      recorder.log,
    );

    const edited = await service.feeds.claim("edited");
    const watched = await service.feeds.claim("watched");
    await sleep(4000);
    assert.equal(edited.isRunning, true);
    assert.equal(watched.isRunning, true);

    // Only the first channel's programming changes. Renaming the second must not count
    // as a change, or every edit in the UI would interrupt whoever is watching.
    const result = service.reload([
      channel("edited", "tt5000099"),
      { ...channel("watched", "tt5000003"), name: "Renamed" },
    ]);

    assert.deepEqual(result.changed, ["edited"]);
    assert.equal(edited.isRunning, false, "the reconfigured channel kept its stale feed");
    assert.equal(
      watched.isRunning,
      true,
      "editing one channel interrupted a viewer watching another",
    );

    // The edited channel's timeline is gone because it no longer reflects the config;
    // the untouched one still has its program.
    assert.equal(db.programsFrom("edited", 0, 10).length, 0);
    assert.equal(db.programsFrom("watched", 0, 10).length, 1);

    service.feeds.stopAll("test complete");
    await sleep(500);
    db.close();
  });
});
