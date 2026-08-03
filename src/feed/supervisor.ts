import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { measureCodecs, type CodecString } from "./codecs.ts";
import type { Config } from "../config.ts";
import { logger, type Logger } from "../log.ts";
import {
  packagerArgs,
  programEncoderArgs,
  slateEncoderArgs,
  type ProgramSource,
} from "./encoder.ts";
import {
  detectEncoder,
  encoderProfile,
  type EncoderKind,
  type EncoderProfile,
} from "./hwaccel.ts";

const exec = promisify(execFile);

/**
 * Which kind of request touched the feed. Playlist polls continue while a viewer is
 * paused; segment fetches do not, which is the whole basis of pause detection.
 */
export type AccessKind = "playlist" | "segment";

/** What the supervisor needs to know about the next thing to air. */
export interface NextProgram {
  title: string;
  source: ProgramSource;
}

/**
 * Asked for whatever should be playing now. Returning null means "nothing available",
 * and the supervisor covers the gap with a slate rather than letting the pipe starve.
 */
export type ProgramProvider = () => Promise<NextProgram | null>;

/** Slate length when covering a gap. Short, so a recovered schedule resumes quickly. */
const GAP_SLATE_SECONDS = 15;
/** Below this the encoder is not worth spawning; skip to the next program instead. */
const MIN_PROGRAM_SECONDS = 5;
/**
 * A source that has not emitted a single transport-stream byte cannot produce an HLS
 * playlist.  Do not let it occupy a playback session forever: terminate it and let the
 * normal signal-loss slate keep the channel playable while the next lookup retries.
 */
const ENCODER_STARTUP_TIMEOUT_MS = 12_000;
/**
 * A player can exhaust the outgoing program's HLS window while the next source opens.
 * During that gap it polls the playlist without requesting segments, which looks exactly
 * like a pause. Protect each encoder handoff long enough for source startup plus two new
 * segments, then let normal pause detection take over again.
 */
const TRANSITION_SEGMENTS_BEFORE_PAUSE = 2;
/**
 * MPEG-TS timestamps wrap at 2^33/90000 ≈ 26.5 hours. Recycling the pipeline well
 * before that avoids the wrap entirely.
 */
const MAX_CURSOR_SECONDS = 20 * 3600;

/**
 * One viewer's pipeline.
 *
 * Deliberately per-viewer rather than per-channel: pausing freezes the encoder, and a
 * shared pipeline would freeze everyone watching that channel. The cost is one encoder
 * and one source connection per viewer, which `SessionManager` caps.
 */
export class PlaybackSession {
  readonly channelId: string;
  readonly sessionId: string;
  private readonly config: Config;
  private readonly provider: ProgramProvider;
  private readonly log: Logger;
  private readonly outDir: string;

  private packager: ChildProcess | null = null;
  private encoder: ChildProcess | null = null;
  private profile: EncoderProfile | null = null;
  private encoder_kind: EncoderKind | null = null;

  /**
   * Codec string read from a segment this feed actually produced. Authoritative for the
   * master playlist: a hardware encoder may not honour the requested profile or level,
   * and advertising what it really emitted is the only way to be sure the player is told
   * the truth. Null until the first measurement completes.
   */
  private measured: CodecString | null = null;
  private measuring = false;

  /** Seconds of content pushed into the packager; becomes each encoder's ts offset. */
  private cursor = 0;
  /** Segment number this run starts from, so the media sequence never goes backwards. */
  private startNumber = 0;
  private running = false;
  private stopping = false;
  /** Any request at all. Drives idle shutdown: this is the liveness signal. */
  private lastAccess = Date.now();
  /**
   * Segment requests only. Drives pause detection.
   *
   * A paused ExoPlayer keeps polling the media playlist every couple of seconds but stops
   * fetching segments entirely, so the gap between these two is what distinguishes a
   * viewer who paused from one who is still watching.
   */
  private lastSegmentAccess = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private drawtextOk = true;
  private claimed = false;
  /** A real segment request has arrived since this pipeline started. */
  private playbackStarted = false;
  /** Number of encoder runs in this pipeline; only runs after the first are handoffs. */
  private encoderRuns = 0;
  /** Pause detection is suppressed until this time while a new source starts. */
  private pauseGuardUntil = 0;

  /** When the viewer paused, or null while running normally. */
  private frozenAt: number | null = null;
  /** The current encoder was deliberately stopped and must be resumed from its offset. */
  private restartAfterPause = false;
  /**
   * Frozen time within the current encoder run. Subtracted from wall-clock elapsed so the
   * cursor and the overrun check measure content produced, not time passed.
   */
  private frozenThisProgram = 0;
  /**
   * Total time this session has spent frozen since it last matched the wall clock. This
   * is how far behind live the viewer now is, and it is surrendered at the next program
   * boundary rather than accumulating forever.
   */
  private drift = 0;
  private resumeWaiters: (() => void)[] = [];

  constructor(
    channelId: string,
    sessionId: string,
    config: Config,
    provider: ProgramProvider,
    parentLog = logger("feed"),
  ) {
    this.channelId = channelId;
    this.sessionId = sessionId;
    this.config = config;
    this.provider = provider;
    // Short session suffix: enough to tell two viewers of one channel apart in the log
    // without making every line unreadable.
    this.log = parentLog.child(`${channelId}/${sessionId.slice(0, 6)}`);
    this.outDir = join(config.dataDir, "hls", channelId, sessionId);
  }

  get playlistPath(): string {
    return join(this.outDir, "live.m3u8");
  }

  get directory(): string {
    return this.outDir;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Seconds since any request touched this session, of either kind. */
  get idleSeconds(): number {
    return (Date.now() - this.lastAccess) / 1000;
  }

  /**
   * Whether a viewer has actually started playback on this session, as opposed to it
   * being a warm pipeline started speculatively when Stremio asked for streams.
   */
  get isClaimed(): boolean {
    return this.claimed;
  }

  markClaimed(): void {
    this.claimed = true;
  }

  /** Whether the encoder is currently suspended because the viewer paused. */
  get isPaused(): boolean {
    return this.frozenAt !== null;
  }

  /** Seconds behind the wall clock, surrendered at the next program boundary. */
  get driftSeconds(): number {
    const open = this.frozenAt === null ? 0 : (Date.now() - this.frozenAt) / 1000;
    return this.drift + open;
  }

  /**
   * Stops the session and removes its segments. Terminal: unlike `stop()`, this session
   * cannot be started again, because its numbering state is gone with the directory.
   */
  dispose(reason: string): void {
    this.stop(reason);
    rmSync(this.outDir, { recursive: true, force: true });
  }

  /** Which encoder this feed is actually using, for diagnostics. */
  get encoderKind(): EncoderKind | null {
    return this.encoder_kind;
  }

  get measuredCodecs(): CodecString | null {
    return this.measured;
  }

  /**
   * Newest segment that is safe to read.
   *
   * Deliberately the *second* newest: ffmpeg is still writing the last one, and probing a
   * half-written segment yields a confusing failure rather than an answer.
   */
  newestSegmentPath(): string | null {
    let segments: string[];
    try {
      segments = readdirSync(this.outDir).filter((f) => /^seg\d+\.ts$/.test(f)).sort();
    } catch {
      return null;
    }
    const settled = segments.at(-2);
    return settled ? join(this.outDir, settled) : null;
  }

  /**
   * Measures the codec string from a real segment, once per feed start, in the
   * background. Never awaited on a request path: the playlist must go out immediately,
   * and until this lands the computed string stands in.
   */
  ensureCodecsMeasured(): void {
    if (this.measured || this.measuring) return;
    const segment = this.newestSegmentPath();
    if (!segment) return;

    this.measuring = true;
    void measureCodecs(segment)
      .then((result) => {
        if (result) {
          this.measured = result;
          this.log.info(`measured codecs ${result.combined} from ${segment.split("/").at(-1)}`);
        }
      })
      .finally(() => {
        this.measuring = false;
      });
  }

  /**
   * Called on every playlist and segment request; drives idle shutdown.
   *
   * `kind` matters: only a segment fetch proves the viewer is actually playing, and that
   * is what pause detection keys off.
   */
  touch(kind: AccessKind): void {
    const now = Date.now();
    this.lastAccess = now;
    if (kind !== "segment") return;

    this.playbackStarted = true;
    this.lastSegmentAccess = now;
    // Thawing here rather than in the watchdog makes resume immediate: the viewer has
    // asked for the next segment, so the encoder must already be running to produce it.
    if (this.frozenAt !== null) this.thaw();
  }

  /** How long since the viewer last fetched a segment. */
  get secondsSinceSegment(): number {
    return (Date.now() - this.lastSegmentAccess) / 1000;
  }

  async ensureStarted(): Promise<void> {
    if (this.running) return;
    // Starting a pipeline is not evidence that playback began. In particular, the first
    // media-playlist request can wait longer than pauseDetectSeconds for cold NVENC output.
    // Pause detection stays disabled until the client asks for a real segment.
    this.lastAccess = Date.now();
    this.lastSegmentAccess = this.lastAccess;
    this.playbackStarted = false;
    this.encoderRuns = 0;
    this.pauseGuardUntil = 0;
    this.running = true;
    this.stopping = false;
    this.cursor = 0;
    // A restart rejoins the wall clock by definition, so any drift the previous run
    // accumulated is already gone.
    this.drift = 0;
    this.frozenThisProgram = 0;
    this.restartAfterPause = false;

    // Read where the previous run got to *before* wiping the directory. This is all the
    // state the sequence needs, so it survives a process restart as well as an idle one.
    const resumeAt = this.nextSegmentNumber();

    // A stale playlist from a previous run would be served to the first viewer before
    // the new packager overwrites it, so start from an empty directory every time.
    rmSync(this.outDir, { recursive: true, force: true });
    mkdirSync(this.outDir, { recursive: true });
    this.startNumber = resumeAt;

    const kind = await detectEncoder(this.config);
    this.profile = encoderProfile(kind, this.config);
    this.encoder_kind = kind;
    this.drawtextOk = await drawtextAvailable();
    // The encoder or the config may have changed since the last run, so any previous
    // measurement is no longer known to describe what this feed is about to emit.
    this.measured = null;

    this.startPackager();
    void this.pump();
    this.startIdleWatch();
    this.log.info(`feed started (${kind})`);
  }

  stop(reason: string): void {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    // A frozen session must not be able to wedge shutdown: release anything waiting on a
    // resume that is never coming, and drop the freeze state so a restart begins clean.
    this.frozenAt = null;
    this.restartAfterPause = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();

    // The encoder is normally already gone while paused, but this also covers a pause
    // signal that has not reached its exit handler yet.
    this.encoder?.kill("SIGKILL");
    this.encoder = null;
    this.packager?.stdin?.end();
    this.packager?.kill("SIGTERM");
    this.packager = null;

    this.log.info(`feed stopped (${reason})`);
  }

  /**
   * One past the highest segment this channel has ever written, read off disk.
   *
   * HLS forbids EXT-X-MEDIA-SEQUENCE from decreasing across a playlist reload. A feed
   * that idles out and is tuned again would otherwise renumber from zero, and a player
   * resuming after a pause sees the timeline jump backwards — tolerated by desktop
   * players, but the kind of thing ExoPlayer treats as a stream reset.
   */
  private nextSegmentNumber(): number {
    let highest = -1;
    try {
      for (const name of readdirSync(this.outDir)) {
        const found = /^seg(\d+)\.ts$/.exec(name);
        if (found) highest = Math.max(highest, Number(found[1]));
      }
    } catch {
      // No directory yet: this channel has never run.
      return 0;
    }
    return highest + 1;
  }

  private startPackager(): void {
    const args = packagerArgs(
      this.playlistPath,
      join(this.outDir, "seg%06d.ts"),
      this.config,
      this.startNumber,
    );
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    proc.stderr?.on("data", (b: Buffer) => this.log.warn(`packager: ${b.toString().trim()}`));

    // EPIPE arrives here whenever an encoder is killed mid-write. It is expected and
    // must not be allowed to become an unhandled error event.
    proc.stdin?.on("error", () => {});

    proc.on("exit", (code, signal) => {
      if (this.stopping) return;
      this.log.error(`packager exited unexpectedly (code=${code} signal=${signal}); restarting feed`);
      this.stop("packager crash");
    });

    this.packager = proc;
  }

  /**
   * The core loop: keep the packager's stdin fed forever. Every path through here must
   * end up pushing *something*, because a gap in the pipe ends the stream for viewers.
   */
  private async pump(): Promise<void> {
    while (this.running) {
      if (this.cursor > MAX_CURSOR_SECONDS) {
        // Restart rather than risk a timestamp wrap. Viewers reconnect; the virtual
        // clock means they resume at the right point in the schedule regardless.
        this.log.info("recycling pipeline before timestamp wrap");
        this.stop("timestamp wrap guard");
        return;
      }

      let next: NextProgram | null = null;
      const askedAt = Date.now();
      try {
        next = await this.provider();
      } catch (err) {
        this.log.error("program provider failed", err);
      }
      // Time spent here is dead air between programs, so it is worth watching.
      const lookupMs = Date.now() - askedAt;
      if (lookupMs > 1000) this.log.warn(`program lookup took ${(lookupMs / 1000).toFixed(1)}s`);
      if (!this.running) return;

      if (!next || next.source.durationSeconds < MIN_PROGRAM_SECONDS) {
        await this.pushSlate(next ? "Up next..." : "Nothing scheduled");
        continue;
      }

      await this.pushProgram(next);

      // Rejoining live needs no machinery of its own: the provider answers from the wall
      // clock, so the next lookup already returns whatever is airing *now* rather than
      // whatever followed in the drifted timeline. Finish the film you paused, then land
      // in the present. All that is left is to stop counting the debt.
      if (this.drift > 0) {
        this.log.info(`rejoining live, discarding ${fmt(this.drift)} of drift`);
        this.drift = 0;
      }
    }
  }

  private async pushProgram(next: NextProgram): Promise<void> {
    const args = programEncoderArgs(next.source, this.cursor, this.profile!, this.config);
    this.log.info(
      `airing "${next.title}" from ${fmt(next.source.offsetSeconds)} for ${fmt(next.source.durationSeconds)}`,
    );

    const startedAt = Date.now();
    this.frozenThisProgram = 0;
    const code = await this.runEncoder(args, next.title);
    // Time spent frozen produced no content, so it must come off the wall-clock reading
    // or every pause would look like an encoder overrun and shift the cursor past what
    // was actually written. An unclosed freeze counts too: the encoder can exit while
    // suspended, which leaves frozenAt still set.
    const openFreeze = this.frozenAt === null ? 0 : (Date.now() - this.frozenAt) / 1000;
    const elapsed = (Date.now() - startedAt) / 1000 - this.frozenThisProgram - openFreeze;

    // Pausing terminates the rate-limited encoder instead of SIGSTOPping it. Some ffmpeg
    // versions try to catch their input clock up after SIGCONT, producing several HLS
    // segments in a burst. A fresh process resumes at the measured content offset and
    // starts with a clean -re clock, so output remains real-time on every supported host.
    if (this.restartAfterPause && !this.stopping && this.running) {
      this.cursor += elapsed;
      const remaining = next.source.durationSeconds - elapsed;
      await this.waitForResume();
      if (!this.running) return;
      this.restartAfterPause = false;
      if (remaining > MIN_PROGRAM_SECONDS) {
        return this.pushProgram({
          title: next.title,
          source: {
            ...next.source,
            offsetSeconds: next.source.offsetSeconds + elapsed,
            durationSeconds: remaining,
          },
        });
      }
      return;
    }

    // A direct-download host can close a connection cleanly before sending enough media
    // for the requested slot. ffmpeg reports that as exit code 0, but accepting it as a
    // completed program leaves the packager with no playlist and immediately retries the
    // same source. Treat a materially short run exactly like an encoder failure.
    const endedEarly = elapsed + 2 < next.source.durationSeconds;
    if ((code !== 0 || endedEarly) && !this.stopping && this.running) {
      this.cursor += elapsed;
      const remaining = next.source.durationSeconds - elapsed;

      this.log.warn(
        `encoder for "${next.title}" ${endedEarly ? "ended early" : `exited ${code}`} after ${fmt(elapsed)}`,
      );
      // The encoder may have died immediately (dead URL) or partway through. The cursor is
      // already advanced by what it produced; let the slate cover the rest of the slot.
      if (remaining > MIN_PROGRAM_SECONDS) {
        await this.pushSlate(`Signal lost - ${next.title}`, Math.min(remaining, GAP_SLATE_SECONDS));
      }
      return;
    }

    // An encoder that runs materially longer than its -t is eating into the next
    // program: viewers join it late by exactly this much.
    const overrun = elapsed - next.source.durationSeconds;
    if (overrun > 2) {
      this.log.warn(
        `encoder overran by ${overrun.toFixed(1)}s ` +
          `(asked ${fmt(next.source.durationSeconds)}, took ${fmt(elapsed)})`,
      );
    }

    this.cursor += next.source.durationSeconds;
  }

  private async pushSlate(text: string, seconds = GAP_SLATE_SECONDS): Promise<void> {
    // Round to whole segments so slates, unlike real programs, never leave a runt
    // segment behind.
    const seg = this.config.hls.segmentSeconds;
    const rounded = Math.max(seg, Math.round(seconds / seg) * seg);
    const args = slateEncoderArgs(
      text,
      rounded,
      this.cursor,
      this.profile!,
      this.config,
      this.drawtextOk,
    );
    // Slates are dead air. They should be rare, so log them where they will be noticed.
    this.log.info(`slate "${text}" for ${fmt(rounded)}`);
    const startedAt = Date.now();
    this.frozenThisProgram = 0;
    await this.runEncoder(args, "slate");
    const openFreeze = this.frozenAt === null ? 0 : (Date.now() - this.frozenAt) / 1000;
    const elapsed = (Date.now() - startedAt) / 1000 - this.frozenThisProgram - openFreeze;

    if (this.restartAfterPause && !this.stopping && this.running) {
      this.cursor += elapsed;
      const remaining = rounded - elapsed;
      await this.waitForResume();
      if (!this.running) return;
      this.restartAfterPause = false;
      if (remaining >= seg) await this.pushSlate(text, remaining);
      return;
    }
    this.cursor += rounded;
  }

  private runEncoder(args: string[], label: string): Promise<number> {
    return new Promise((resolve) => {
      if (!this.packager?.stdin || !this.running) {
        resolve(-1);
        return;
      }

      if (this.encoderRuns > 0) {
        this.pauseGuardUntil = Date.now() + ENCODER_STARTUP_TIMEOUT_MS +
          TRANSITION_SEGMENTS_BEFORE_PAUSE * this.config.hls.segmentSeconds * 1000;
      }
      this.encoderRuns += 1;

      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.encoder = proc;
      let emittedOutput = false;
      const startupTimer = setTimeout(() => {
        if (emittedOutput || !this.isAlive(proc)) return;
        this.log.warn(`${label}: no output after ${ENCODER_STARTUP_TIMEOUT_MS / 1000}s; retrying`);
        proc.kill("SIGTERM");
      }, ENCODER_STARTUP_TIMEOUT_MS);

      // end:false is what makes the handoff work — the packager's stdin must survive
      // this encoder so the next one can write into the same stream.
      proc.stdout?.once("data", () => {
        emittedOutput = true;
        clearTimeout(startupTimer);
      });
      proc.stdout?.pipe(this.packager.stdin, { end: false });
      proc.stderr?.on("data", (b: Buffer) => {
        const msg = b.toString().trim();
        if (msg) this.log.warn(`${label}: ${msg}`);
      });
      proc.on("error", (err) => {
        clearTimeout(startupTimer);
        this.log.error(`failed to spawn encoder for ${label}`, err);
        resolve(-1);
      });
      proc.on("exit", (code) => {
        clearTimeout(startupTimer);
        if (this.encoder === proc) this.encoder = null;
        resolve(code ?? -1);
      });
    });
  }

  /**
   * Stops the encoder while the viewer is paused.
   *
   * Nothing is produced during a freeze, so there is no buffer to accumulate and no live
   * edge to fall behind: the playlist simply stops advancing, leaving its last segment —
   * the frame the viewer paused on — as the newest thing available. That is what makes an
   * arbitrarily long pause cost nothing and lose nothing.
   *
   * Only the encoder is stopped. The packager stays up to serve the playlist it has
   * already written; with no input it simply writes nothing more. Resume creates a new
   * rate-limited encoder at the exact source offset, avoiding ffmpeg's SIGCONT catch-up
   * behavior on fast machines.
   */
  private freeze(): void {
    if (this.frozenAt !== null) return;
    // Only a viewer who started playing can pause. A warm session has never served a
    // segment and would otherwise be frozen the moment it was created, defeating the
    // point of warming it — and leaving it suspended until it idled out.
    if (!this.claimed) return;
    if (!this.playbackStarted) return;

    const proc = this.encoder;
    if (!proc || !this.isAlive(proc)) return;

    this.frozenAt = Date.now();
    this.restartAfterPause = true;
    try {
      if (!proc.kill("SIGKILL")) {
        this.frozenAt = null;
        this.restartAfterPause = false;
        return;
      }
    } catch (err) {
      this.log.warn(`could not freeze encoder: ${String(err)}`);
      this.frozenAt = null;
      this.restartAfterPause = false;
      return;
    }
    this.log.info("viewer paused; encoder stopped");
  }

  /** Settles when the viewer resumes, or immediately if they are not paused. */
  private waitForResume(): Promise<void> {
    if (this.frozenAt === null) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  /** Resumes the encoder, and records how far behind the wall clock the pause left us. */
  private thaw(): void {
    if (this.frozenAt === null) return;

    const frozenFor = (Date.now() - this.frozenAt) / 1000;
    this.frozenAt = null;
    this.frozenThisProgram += frozenFor;
    this.drift += frozenFor;

    this.log.info(
      `viewer resumed after ${fmt(frozenFor)} (drift ${fmt(this.drift)}); restarting encoder`,
    );

    // Releases the interrupted program or slate so it can respawn its encoder.
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Distinguishes a running process from one whose exit has already been observed.
   */
  private isAlive(proc: ChildProcess): boolean {
    return proc.exitCode === null && proc.signalCode === null;
  }

  private startIdleWatch(): void {
    // Runs often enough that the encoder is not left burning GPU for long after a viewer
    // pauses. Resume is handled in touch(), not here, so this interval never delays it.
    this.idleTimer = setInterval(() => {
      if (!this.running) return;

      // Absent segment fetches alone do not mean paused — a viewer who backed out of the
      // channel looks identical by that measure. Measured on a Fire TV: a paused player
      // keeps polling the playlist every ~2s, while one that stopped goes silent on both
      // counts. Requiring a recent poll is what separates them, and it keeps an abandoned
      // session from being suspended with nobody coming back to thaw it.
      const window = this.config.hls.pauseDetectSeconds;
      if (
        this.frozenAt === null &&
        Date.now() >= this.pauseGuardUntil &&
        this.secondsSinceSegment > window &&
        this.idleSeconds < window
      ) {
        this.freeze();
      }

      // A paused viewer keeps polling the playlist, so lastAccess keeps moving and this
      // does not fire. Only a genuinely abandoned session idles out.
      const idleFor = (Date.now() - this.lastAccess) / 1000;
      if (idleFor > this.config.idleShutdownSeconds) {
        this.stop(`idle for ${Math.round(idleFor)}s`);
      }
    }, 2_000);
  }
}

/**
 * How long a stopped session is kept around before its directory is removed. Non-zero so
 * a player that reconnects with the same session id shortly after an idle shutdown still
 * finds its segment numbering, which HLS requires never to go backwards.
 */
const DISPOSE_GRACE_SECONDS = 300;

/**
 * Registry of playback sessions, keyed by session id.
 *
 * Sessions are created on tune-in and torn down when idle, which is what lets channels be
 * conceptually 24/7 while costing nothing when nobody is watching. One channel may have
 * several concurrent sessions — that is the point, since it is what lets one viewer pause
 * without pausing another.
 */
export class SessionManager {
  private readonly sessions = new Map<string, PlaybackSession>();
  private reaper: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly providerFor: (channelId: string) => ProgramProvider,
    private readonly parentLog = logger("feed"),
  ) {}

  /**
   * Starts a pipeline for a channel without attaching a viewer to it yet.
   *
   * Stremio asks for streams a beat before the user presses play, and encoders run at
   * real time, so this is what turns a cold start into a warm one. An unclaimed session
   * that nobody goes on to play simply idles out.
   */
  async warm(channelId: string): Promise<PlaybackSession> {
    this.evictIfFull();

    const session = new PlaybackSession(
      channelId,
      randomUUID(),
      this.config,
      this.providerFor(channelId),
      this.parentLog,
    );
    this.sessions.set(session.sessionId, session);
    this.startReaper();

    await session.ensureStarted();
    return session;
  }

  /**
   * Gets a session for a viewer who is actually starting playback.
   *
   * Adopts a warm unclaimed session for the channel if one is waiting, so the work done
   * by `warm()` is not thrown away — without this, every playback would pay the cold
   * start twice and burn two encoder slots doing it.
   */
  async claim(channelId: string): Promise<PlaybackSession> {
    const warmed = this.forChannel(channelId).find((s) => !s.isClaimed && s.isRunning);
    if (warmed) {
      warmed.markClaimed();
      await warmed.ensureStarted();
      return warmed;
    }

    const session = await this.warm(channelId);
    session.markClaimed();
    return session;
  }

  get(sessionId: string): PlaybackSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every live session on a channel, for diagnostics and channel-wide teardown. */
  forChannel(channelId: string): PlaybackSession[] {
    return [...this.sessions.values()].filter((s) => s.channelId === channelId);
  }

  /** Whether anyone is currently watching a channel. */
  isChannelLive(channelId: string): boolean {
    return this.forChannel(channelId).some((s) => s.isRunning);
  }

  stopChannel(channelId: string, reason: string): void {
    for (const session of this.forChannel(channelId)) session.stop(reason);
  }

  stopAll(reason: string): void {
    for (const session of this.sessions.values()) session.stop(reason);
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  /**
   * Each session holds a hardware encoder session, and GPUs cap how many may exist at
   * once. Rather than letting the (N+1)th viewer fail inside ffmpeg with an opaque error,
   * reclaim the least recently used session.
   */
  private evictIfFull(): void {
    while (this.sessions.size >= this.config.maxSessions) {
      const oldest = [...this.sessions.values()].sort(
        (a, b) => b.idleSeconds - a.idleSeconds,
      )[0];
      if (!oldest) return;
      this.parentLog.warn(
        `session limit (${this.config.maxSessions}) reached; evicting ${oldest.channelId}/${oldest.sessionId.slice(0, 6)}`,
      );
      oldest.dispose("evicted for a new session");
      this.sessions.delete(oldest.sessionId);
    }
  }

  private startReaper(): void {
    if (this.reaper) return;
    // Stopped sessions keep their directory for a grace period, so this cannot simply run
    // off `isRunning`.
    this.reaper = setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.isRunning) continue;
        if (session.idleSeconds < DISPOSE_GRACE_SECONDS) continue;
        session.dispose("session expired");
        this.sessions.delete(id);
      }
    }, 30_000);
    this.reaper.unref?.();
  }
}

let drawtextCache: boolean | undefined;

/**
 * Runs the one-off ffmpeg capability probes up front. Both are cached for the process,
 * but doing them lazily meant the very first viewer paid a couple of seconds for a test
 * encode before their channel could even start.
 */
export async function warmCapabilities(config: Config): Promise<void> {
  await Promise.all([detectEncoder(config), drawtextAvailable()]);
}

/** drawtext needs fontconfig and a font present; without one the filtergraph fails to build. */
async function drawtextAvailable(): Promise<boolean> {
  if (drawtextCache !== undefined) return drawtextCache;
  try {
    await exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=64x64:d=0.1",
      "-vf", "drawtext=font=sans:text=x:fontcolor=white",
      "-f", "null", "-",
    ], { timeout: 10_000 });
    drawtextCache = true;
  } catch {
    logger("feed").warn("drawtext unavailable (no fontconfig font); slates will be blank");
    drawtextCache = false;
  }
  return drawtextCache;
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
