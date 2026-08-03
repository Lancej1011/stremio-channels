/**
 * Integration tests for the encoder → packager pipeline.
 *
 * These spawn real ffmpeg processes and run in real time, because that is the only way
 * to observe the property the whole project rests on: that a channel is one unbroken
 * stream even though a separate encoder process produced each program.
 *
 * Run with `npm run test:integration`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  continuity,
  makeClip,
  packetsFrom,
  recordingLogger,
  sleep,
  testConfig,
} from "../testing/harness.ts";
import { PlaybackSession, type NextProgram } from "./supervisor.ts";

/** Each program in these tests. Long enough to span several segments, short enough to wait for. */
const PROGRAM_SECONDS = 6;
/** One frame at the test config's 15fps. */
const FRAME_SECONDS = 1 / 15;

const root = mkdtempSync(join(tmpdir(), "chan-feed-itest-"));
let clipA = "";
let clipB = "";

before(async () => {
  // One long clip is enough for every program: they differ by the offset they seek to,
  // which is exactly how a real mid-program tune-in works.
  clipA = await makeClip(join(root, "a.mp4"), { seconds: 90 });
  clipB = await makeClip(join(root, "b.mp4"), {
    seconds: 90,
    source: "smptebars=size=320x240:rate=15",
  });
}, { timeout: 120_000 });

after(() => rmSync(root, { recursive: true, force: true }));

/**
 * Feeds a fixed list of programs, then reports exhaustion. `drained` resolves the moment
 * the supervisor asks for one more than there is, which is the signal that everything
 * under test has actually been through the pipe.
 */
function queueProvider(programs: NextProgram[]) {
  let index = 0;
  let signal: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    drained,
    get served() {
      return index;
    },
    provider: async (): Promise<NextProgram | null> => {
      const next = programs[index++];
      if (!next) {
        signal();
        return null;
      }
      return next;
    },
  };
}

function segmentCount(feed: PlaybackSession): number {
  try {
    return readdirSync(feed.directory).filter((name) => /^seg\d+\.ts$/.test(name)).length;
  } catch {
    return 0;
  }
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(200);
  assert.ok(check(), message);
}

describe("feed pipeline", { timeout: 180_000 }, () => {
  it("keeps video timestamps monotonic and hole-free across program changes", async () => {
    const dataDir = join(root, "monotonic");
    const config = testConfig(dataDir);
    const recorder = recordingLogger();

    const queue = queueProvider([
      { title: "One", source: { url: clipA, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
      // A mid-program join, which is what tuning in late produces.
      { title: "Two", source: { url: clipB, offsetSeconds: 30, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
      { title: "Three", source: { url: clipA, offsetSeconds: 60, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
    ]);

    const feed = new PlaybackSession("monotonic", "test", config, queue.provider, recorder.log);
    await feed.ensureStarted();
    await queue.drained;
    // Let the packager close out the segment it is mid-way through writing, so the tail
    // of the last program is on disk before anything is asserted.
    await sleep(2500);
    feed.stop("test complete");
    await sleep(500);

    assert.equal(queue.served, 4, "the supervisor stopped asking for programs");

    const video = continuity(await packetsFrom(join(dataDir, "hls", "monotonic", "test"), "v"));

    assert.ok(video.count > 0, "the packager produced no video at all");
    assert.equal(
      video.maxBacktrackSeconds,
      0,
      `video PTS went backwards by ${video.maxBacktrackSeconds.toFixed(3)}s — ` +
        "a player treats this as a broken stream",
    );
    // A hole larger than a couple of frames is a visible stall at the handoff, which is
    // precisely what the per-encoder -output_ts_offset exists to prevent.
    assert.ok(
      video.maxGapSeconds < FRAME_SECONDS * 3,
      `largest video gap was ${video.maxGapSeconds.toFixed(3)}s, expected under ` +
        `${(FRAME_SECONDS * 3).toFixed(3)}s`,
    );
    // Three programs of six seconds. Allow for the tail the packager had not flushed.
    assert.ok(
      video.spanSeconds > PROGRAM_SECONDS * 3 - 2,
      `only ${video.spanSeconds.toFixed(1)}s of video for three ${PROGRAM_SECONDS}s programs`,
    );

    // All three titles aired, in order, rather than one being skipped.
    assert.deepEqual(
      recorder.matching(/airing "/).map((l) => /airing "([^"]+)"/.exec(l)![1]),
      ["One", "Two", "Three"],
    );
  });

  it("keeps audio overlap at a program change bounded, and stops it accumulating", async () => {
    const dataDir = join(root, "audio");
    const config = testConfig(dataDir);
    const recorder = recordingLogger();

    // Three programs, so there are two boundaries to compare against each other.
    const queue = queueProvider([
      { title: "One", source: { url: clipA, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
      { title: "Two", source: { url: clipB, offsetSeconds: 10, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
      { title: "Three", source: { url: clipA, offsetSeconds: 40, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
    ]);

    const feed = new PlaybackSession("audio", "test", config, queue.provider, recorder.log);
    await feed.ensureStarted();
    await queue.drained;
    await sleep(2500);
    feed.stop("test complete");
    await sleep(500);

    const hls = join(dataDir, "hls", "audio", "test");
    const audio = continuity(await packetsFrom(hls, "a"));
    const video = continuity(await packetsFrom(hls, "v"));
    assert.ok(audio.count > 0, "the packager produced no audio at all");

    // A known limitation, measured here rather than assumed. An AAC frame is 1024
    // samples (21.3ms at 48kHz) and a program boundary does not land on one, so the
    // outgoing encoder rounds up to a whole frame while the incoming one starts up to a
    // frame early. That structurally caps the overlap at two frames; measured values sit
    // between roughly 16ms and 37ms depending on where the boundary falls in the frame.
    const aacFrame = 1024 / config.audio.sampleRate;
    assert.ok(
      audio.maxBacktrackSeconds < aacFrame * 3,
      `audio overlapped by ${(audio.maxBacktrackSeconds * 1000).toFixed(1)}ms, expected ` +
        `well under three AAC frames (${(aacFrame * 3000).toFixed(1)}ms)`,
    );
    assert.ok(
      audio.maxGapSeconds < aacFrame * 3,
      `largest audio gap was ${(audio.maxGapSeconds * 1000).toFixed(1)}ms`,
    );

    // The overlap being small only matters if it stays small. If each boundary shaved a
    // fraction off the audio timeline, audio and video would drift apart over a day of
    // programs, which is a genuinely audible fault rather than a cosmetic one.
    const drift = Math.abs(audio.spanSeconds - video.spanSeconds);
    assert.ok(
      drift < 0.25,
      `audio covered ${audio.spanSeconds.toFixed(3)}s against ${video.spanSeconds.toFixed(3)}s ` +
        `of video — ${(drift * 1000).toFixed(0)}ms of drift across two program changes`,
    );
  });

  it("covers a dead source with a slate and keeps the feed alive", async () => {
    const dataDir = join(root, "dead-source");
    const config = testConfig(dataDir);
    const recorder = recordingLogger();

    const queue = queueProvider([
      { title: "Good", source: { url: clipA, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
      // A link that has expired or a host that has gone away: ffmpeg exits immediately
      // and nonzero, leaving the rest of the slot to cover.
      {
        title: "Dead",
        source: {
          url: join(root, "does-not-exist.mp4"),
          offsetSeconds: 0,
          durationSeconds: 60,
          hasAudio: true,
        },
      },
      { title: "Recovered", source: { url: clipB, offsetSeconds: 5, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
    ]);

    const feed = new PlaybackSession("dead-source", "test", config, queue.provider, recorder.log);
    await feed.ensureStarted();
    await queue.drained;
    await sleep(2500);

    assert.equal(feed.isRunning, true, "a dead source took the whole feed down");
    feed.stop("test complete");
    await sleep(500);

    assert.ok(
      recorder.matching(/slate "Signal lost - Dead"/).length === 1,
      `expected exactly one signal-lost slate, saw:\n${recorder.lines.join("\n")}`,
    );
    // The important half: the schedule moved on rather than getting stuck on the corpse.
    assert.deepEqual(
      recorder.matching(/airing "/).map((l) => /airing "([^"]+)"/.exec(l)![1]),
      ["Good", "Dead", "Recovered"],
    );

    const video = continuity(await packetsFrom(join(dataDir, "hls", "dead-source", "test"), "v"));
    assert.equal(
      video.maxBacktrackSeconds,
      0,
      "video PTS went backwards across the slate",
    );
    assert.ok(
      video.maxGapSeconds < FRAME_SECONDS * 3,
      `the slate left a ${video.maxGapSeconds.toFixed(3)}s hole in the stream`,
    );
  });

  it("substitutes silence for a source with no audio track", async () => {
    const dataDir = join(root, "silent");
    const config = testConfig(dataDir);
    const recorder = recordingLogger();
    const silent = await makeClip(join(root, "silent.mp4"), { seconds: 30, silent: true });

    const queue = queueProvider([
      { title: "Silent", source: { url: silent, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: false } },
      { title: "Sound", source: { url: clipA, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
    ]);

    const feed = new PlaybackSession("silent", "test", config, queue.provider, recorder.log);
    await feed.ensureStarted();
    await queue.drained;
    await sleep(2500);
    feed.stop("test complete");
    await sleep(500);

    // Without the anullsrc substitution the packager sees a stream that gains an audio
    // track partway through, which players handle far worse than silence.
    const audio = continuity(await packetsFrom(join(dataDir, "hls", "silent", "test"), "a"));
    assert.ok(
      audio.spanSeconds > PROGRAM_SECONDS * 2 - 3,
      `audio covered only ${audio.spanSeconds.toFixed(1)}s of a ${PROGRAM_SECONDS * 2}s pair`,
    );
  });

  it("shuts down when idle and starts clean on the next tune-in", async () => {
    const dataDir = join(root, "idle");
    // The idle watch ticks every 2s (it also drives pause detection, which needs that
    // granularity), so shutdown lands within a couple of seconds of the threshold. The
    // threshold is deliberately not 1s: the point of this test is that nothing keeps
    // encoding *after* shutdown, which is only meaningful if something was encoded
    // before it. At 1s the feed died before producing a single segment.
    const config = testConfig(dataDir, { idleShutdownSeconds: 8 });
    const recorder = recordingLogger();

    const queue = queueProvider([
      { title: "One", source: { url: clipA, offsetSeconds: 0, durationSeconds: 120, hasAudio: true } },
    ]);

    const feed = new PlaybackSession("idle", "test", config, queue.provider, recorder.log);
    await feed.ensureStarted();
    assert.equal(feed.isRunning, true);

    await recorder.waitFor(/feed stopped \(idle for/, 60_000);
    assert.equal(feed.isRunning, false, "the feed reported idle shutdown but kept running");

    // Nobody is watching, so nothing may still be encoding. A leaked ffmpeg here is a
    // channel that costs CPU forever after one viewer glanced at it.
    //
    // The packager is stopped with SIGTERM and legitimately flushes the segment it was
    // part-way through, so the first sample is taken after that has settled; two samples
    // three seconds apart is what distinguishes a flush from a process still running.
    await sleep(3000);
    const settled = (await packetsFrom(join(dataDir, "hls", "idle", "test"), "v")).length;
    await sleep(3000);
    const later = (await packetsFrom(join(dataDir, "hls", "idle", "test"), "v")).length;
    // Guards against the comparison below passing vacuously: if the directory were wrong
    // or empty, 0 == 0 would look like a pass while asserting nothing whatsoever.
    assert.ok(settled > 0, "no video was produced before idle shutdown, so this proves nothing");
    assert.equal(later, settled, "the pipeline kept producing video after idle shutdown");

    // Re-tuning restarts from an empty directory: a stale playlist would otherwise be
    // served to the first viewer before the new packager overwrote it.
    const second = queueProvider([
      { title: "Two", source: { url: clipB, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true } },
    ]);
    const restarted = new PlaybackSession("idle", "test", testConfig(dataDir), second.provider, recorder.log);
    await restarted.ensureStarted();
    await second.drained;
    await sleep(2000);
    restarted.stop("test complete");
    await sleep(500);

    const video = continuity(await packetsFrom(join(dataDir, "hls", "idle", "test"), "v"));
    assert.ok(
      video.spanSeconds < PROGRAM_SECONDS + 4,
      `the restarted feed served ${video.spanSeconds.toFixed(1)}s, so segments from the ` +
        "previous run survived the restart",
    );
    assert.equal(video.maxBacktrackSeconds, 0);
  });

  it("freezes a paused viewer and resumes without a catch-up burst", async () => {
    const dataDir = join(root, "pause-resume");
    const base = testConfig(dataDir);
    const config = testConfig(dataDir, {
      hls: { ...base.hls, pauseDetectSeconds: 2 },
    });
    const recorder = recordingLogger();
    const queue = queueProvider([{
      title: "Paused program",
      source: { url: clipA, offsetSeconds: 0, durationSeconds: 60, hasAudio: true },
    }]);
    const feed = new PlaybackSession("pause-resume", "test", config, queue.provider, recorder.log);

    await feed.ensureStarted();
    feed.markClaimed();
    const playing = setInterval(() => feed.touch("segment"), 400);
    await waitUntil(() => segmentCount(feed) >= 3, "the claimed session produced no segments");
    clearInterval(playing);

    const polling = setInterval(() => feed.touch("playlist"), 400);
    await waitUntil(() => feed.isPaused, "playlist-only access did not freeze the encoder");
    // Let the packager flush the partial segment already in its pipe, then hold long enough
    // that a wall-clock-based -re catch-up would be unmistakable after resume.
    await sleep(1500);
    const frozenCount = segmentCount(feed);
    await sleep(6000);
    assert.equal(segmentCount(feed), frozenCount, "segments advanced while the viewer was paused");

    clearInterval(polling);
    feed.touch("segment");
    assert.equal(feed.isPaused, false, "a segment request did not resume the session");
    const resumedAt = segmentCount(feed);
    await sleep(3500);
    const produced = segmentCount(feed) - resumedAt;
    assert.ok(produced >= 2, `only ${produced} segments were produced after resume`);
    assert.ok(
      produced <= 5,
      `resume produced ${produced} one-second segments in 3.5s; ffmpeg caught up in a burst`,
    );

    feed.stop("test complete");
    await sleep(500);
    const video = continuity(await packetsFrom(feed.directory, "v"));
    assert.ok(video.count > 0);
    assert.equal(video.maxBacktrackSeconds, 0, "video timestamps went backwards across resume");
    assert.equal(recorder.matching(/viewer paused; encoder stopped/).length, 1);
    assert.equal(recorder.matching(/viewer resumed after/).length, 1);
  });

  it("does not freeze a claimed cold session before its first segment request", async () => {
    const dataDir = join(root, "cold-claim");
    const base = testConfig(dataDir);
    const config = testConfig(dataDir, {
      hls: { ...base.hls, segmentSeconds: 4, pauseDetectSeconds: 1 },
    });
    const queue = queueProvider([{
      title: "Cold program",
      source: { url: clipA, offsetSeconds: 0, durationSeconds: 60, hasAudio: true },
    }]);
    const feed = new PlaybackSession("cold-claim", "test", config, queue.provider);

    await feed.ensureStarted();
    feed.markClaimed();
    const polling = setInterval(() => feed.touch("playlist"), 300);
    // The watchdog ticks at two seconds, while a four-second HLS segment cannot exist yet.
    // The old detector froze here because claim alone was mistaken for active playback.
    await sleep(3500);
    assert.equal(feed.isPaused, false, "a claimed session froze before any segment was requested");

    clearInterval(polling);
    feed.stop("test complete");
    await sleep(500);
  });

  it("does not mistake buffering at a program boundary for a viewer pause", async () => {
    const dataDir = join(root, "boundary-buffering");
    const base = testConfig(dataDir);
    const config = testConfig(dataDir, {
      hls: { ...base.hls, pauseDetectSeconds: 1 },
    });
    const recorder = recordingLogger();
    const queue = queueProvider([
      {
        title: "Outgoing",
        source: { url: clipA, offsetSeconds: 0, durationSeconds: PROGRAM_SECONDS, hasAudio: true },
      },
      {
        title: "Incoming",
        source: { url: clipB, offsetSeconds: 10, durationSeconds: 60, hasAudio: true },
      },
    ]);
    const feed = new PlaybackSession(
      "boundary-buffering",
      "test",
      config,
      queue.provider,
      recorder.log,
    );

    await feed.ensureStarted();
    feed.markClaimed();
    const playing = setInterval(() => feed.touch("segment"), 300);
    await waitUntil(() => segmentCount(feed) >= 3, "the first program produced no segments");
    await recorder.waitFor(/airing "Incoming"/, 20_000);

    // At a real remote-source handoff the old buffer can run dry before the new source
    // yields segments. Stremio keeps polling the playlist during that interval, exactly
    // as it does for a deliberate pause. The one-second detector must not kill the new
    // encoder while it is still inside its transition grace period.
    clearInterval(playing);
    const polling = setInterval(() => feed.touch("playlist"), 300);
    await sleep(3500);
    assert.equal(feed.isPaused, false, "the program handoff was misclassified as a pause");

    clearInterval(polling);
    feed.stop("test complete");
    await sleep(500);
    assert.equal(recorder.matching(/viewer paused; encoder stopped/).length, 0);
  });

  it("keeps a second viewer advancing while the first viewer is paused", async () => {
    const dataDir = join(root, "two-viewers");
    const base = testConfig(dataDir);
    const config = testConfig(dataDir, {
      hls: { ...base.hls, pauseDetectSeconds: 2 },
    });
    const program = (title: string): NextProgram => ({
      title,
      source: { url: clipB, offsetSeconds: 0, durationSeconds: 60, hasAudio: true },
    });
    const first = new PlaybackSession(
      "shared",
      "viewer-one",
      config,
      queueProvider([program("First")]).provider,
    );
    const second = new PlaybackSession(
      "shared",
      "viewer-two",
      config,
      queueProvider([program("Second")]).provider,
    );

    await Promise.all([first.ensureStarted(), second.ensureStarted()]);
    first.markClaimed();
    second.markClaimed();
    const firstPlaying = setInterval(() => first.touch("segment"), 400);
    const secondPlaying = setInterval(() => second.touch("segment"), 400);
    await waitUntil(
      () => segmentCount(first) >= 3 && segmentCount(second) >= 3,
      "both viewer sessions did not start",
    );

    clearInterval(firstPlaying);
    const firstPolling = setInterval(() => first.touch("playlist"), 400);
    await waitUntil(() => first.isPaused, "the first viewer did not pause");
    await sleep(1500);
    const firstFrozen = segmentCount(first);
    const secondBefore = segmentCount(second);
    await sleep(3500);

    clearInterval(firstPolling);
    clearInterval(secondPlaying);
    assert.equal(segmentCount(first), firstFrozen, "the paused viewer kept advancing");
    assert.ok(
      segmentCount(second) >= secondBefore + 2,
      "pausing one viewer stopped the other viewer's independent session",
    );

    first.stop("test complete");
    second.stop("test complete");
    await sleep(500);
  });
});
