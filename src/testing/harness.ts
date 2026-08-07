/**
 * Helpers for the integration suite (`npm run test:integration`).
 *
 * These tests drive the *real* pipeline — real ffmpeg encoders, a real packager, the
 * real SQLite database — against synthetic local sources instead of debrid links. That
 * is the whole point: the encoder/supervisor/packager is the part of this project that
 * can break someone's viewing, and every bug found in it so far came from watching logs
 * by hand rather than from a test.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import type { Logger } from "../log.ts";

const exec = promisify(execFile);

/**
 * A deliberately tiny channel: 320x240 at 15fps encodes comfortably faster than real
 * time on any machine, so a test that asserts on timing is measuring the pipeline and
 * not the CPU. Everything else matches production shape.
 */
export function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  // Parsed from the schema rather than hand-built, so a new config field with a default
  // does not silently arrive as undefined here.
  const base = loadConfig(join(dataDir, "no-such-config.json"));
  return {
    ...base,
    dataDir,
    channelsFile: join(dataDir, "channels.json"),
    // Pinned: auto-detection would pick a different encoder on different machines, and
    // hardware encoders are the ones most likely to be busy or absent on CI.
    encoder: "cpu",
    // Integration fixtures intentionally place synthetic local clip paths in SQLite and
    // have no resolver that could recreate them. Production defaults to memory-only URLs.
    persistResolvedUrls: true,
    idleShutdownSeconds: 3600,
    scheduleHorizonHours: 24,
    // Spread the parsed defaults rather than replacing each block wholesale, so a new
    // schema field arrives here with its default instead of failing the build.
    video: { ...base.video, width: 320, height: 240, fps: 15, bitrate: "400k", gopSeconds: 1 },
    audio: { ...base.audio, bitrate: "64k", sampleRate: 48000, channels: 2 },
    // listSize is large enough that nothing is ever deleted mid-test; the assertions
    // read the segments back off disk after the fact.
    hls: { ...base.hls, segmentSeconds: 1, listSize: 500 },
    ...overrides,
  };
}

export interface ClipOptions {
  seconds: number;
  /** Silent clips exercise the encoder's anullsrc substitution path. */
  silent?: boolean;
  /**
   * lavfi source, without its duration. `testsrc` carries a frame counter, which makes
   * drift visible; a long clip that only needs a plausible duration is far cheaper as
   * a low-rate `color` source.
   */
  source?: string;
}

/**
 * Writes a synthetic source file. Clips are cached by path so a suite of tests sharing
 * one temp directory only pays for encoding them once.
 */
export async function makeClip(path: string, opts: ClipOptions): Promise<string> {
  if (existsSync(path)) return path;

  const { seconds, silent = false, source = "testsrc=size=320x240:rate=15" } = opts;
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `${source}:duration=${seconds}`,
  ];
  if (!silent) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  }
  args.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15",
    ...(silent ? [] : ["-c:a", "aac", "-b:a", "64k"]),
    "-t", String(seconds),
    path,
  );

  await exec("ffmpeg", args, { timeout: 120_000 });
  return path;
}

export interface Packet {
  ptsSeconds: number;
  dtsSeconds: number;
}

/**
 * Every packet the packager actually wrote, read back off disk.
 *
 * The segments are concatenated first: a per-segment read would hide exactly the thing
 * worth checking, which is whether timestamps stay continuous *across* the boundary
 * where one encoder handed over to the next.
 */
export async function packetsFrom(hlsDir: string, stream: "v" | "a"): Promise<Packet[]> {
  const segments = readdirSync(hlsDir)
    // Name-anchored, so the concatenation this function writes is never itself read back
    // in as a segment on a second call.
    .filter((f) => /^seg\d+\.ts$/.test(f))
    .sort();
  if (segments.length === 0) return [];

  const joined = join(hlsDir, `joined-${stream}.ts`);
  writeFileSync(joined, Buffer.concat(segments.map((f) => readFileSync(join(hlsDir, f)))));

  const { stdout } = await exec(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", stream,
      "-show_entries", "packet=pts_time,dts_time",
      "-of", "csv=p=0",
      joined,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pts, dts] = line.split(",");
      return { ptsSeconds: Number(pts), dtsSeconds: Number(dts) };
    })
    .filter((p) => Number.isFinite(p.ptsSeconds));
}

export interface Continuity {
  count: number;
  firstPts: number;
  lastPts: number;
  spanSeconds: number;
  /** Largest forward jump between consecutive packets — a hole in the stream. */
  maxGapSeconds: number;
  /** Largest backward step. Anything above zero means timestamps went backwards. */
  maxBacktrackSeconds: number;
}

export function continuity(packets: readonly Packet[]): Continuity {
  let maxGap = 0;
  let maxBacktrack = 0;
  for (let i = 1; i < packets.length; i++) {
    const delta = packets[i]!.ptsSeconds - packets[i - 1]!.ptsSeconds;
    if (delta > maxGap) maxGap = delta;
    if (-delta > maxBacktrack) maxBacktrack = -delta;
  }
  const first = packets[0]?.ptsSeconds ?? 0;
  const last = packets.at(-1)?.ptsSeconds ?? 0;
  return {
    count: packets.length,
    firstPts: first,
    lastPts: last,
    spanSeconds: last - first,
    maxGapSeconds: maxGap,
    maxBacktrackSeconds: maxBacktrack,
  };
}

export interface RecordingLogger {
  log: Logger;
  lines: string[];
  /** Waits for a line matching `pattern`, including ones already recorded. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  matching(pattern: RegExp): string[];
}

/**
 * The supervisor reports what it is doing through its logger and nothing else, so for a
 * test that is the observation point: which program aired, at what offset, and whether a
 * slate covered a gap.
 */
export function recordingLogger(echo = process.env.LOG_LEVEL === "debug"): RecordingLogger {
  const lines: string[] = [];
  const watchers = new Set<{ pattern: RegExp; resolve: (line: string) => void }>();

  const record = (level: string, scope: string, msg: string, extra?: unknown) => {
    const line = `${level} [${scope}] ${msg}${extra === undefined ? "" : ` ${String(extra)}`}`;
    lines.push(line);
    if (echo) process.stdout.write(`${line}\n`);
    for (const watcher of [...watchers]) {
      if (watcher.pattern.test(line)) {
        watchers.delete(watcher);
        watcher.resolve(line);
      }
    }
  };

  const make = (scope: string): Logger => ({
    debug: (m, e) => record("DEBUG", scope, m, e),
    info: (m, e) => record("INFO", scope, m, e),
    warn: (m, e) => record("WARN", scope, m, e),
    error: (m, e) => record("ERROR", scope, m, e),
    child: (sub: string) => make(`${scope}:${sub}`),
  });

  return {
    log: make("test"),
    lines,
    matching: (pattern) => lines.filter((l) => pattern.test(l)),
    waitFor(pattern, timeoutMs = 60_000) {
      const already = lines.find((l) => pattern.test(l));
      if (already) return Promise.resolve(already);
      return new Promise<string>((resolve, reject) => {
        const watcher = {
          pattern,
          resolve: (line: string) => {
            clearTimeout(timer);
            resolve(line);
          },
        };
        const timer = setTimeout(() => {
          watchers.delete(watcher);
          reject(new Error(`timed out waiting for ${pattern}\nsaw:\n${lines.join("\n")}`));
        }, timeoutMs);
        watchers.add(watcher);
      });
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
