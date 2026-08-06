import type { ChannelDef, Config, ContentRef } from "../config.ts";
import { parseRefKey, refKey } from "../config.ts";
import { Cinemeta } from "../content/cinemeta.ts";
import { probeCached } from "../content/probe.ts";
import type {
  PreparatoryResolver,
  FailoverResolver,
  PreparedStream,
  RefreshableResolver,
  ResolvedStream,
  StreamResolver,
} from "../content/resolver.ts";
import type { Db, ProgramRow } from "../db.ts";
import { logger, type Logger } from "../log.ts";
import { activeBlock } from "./dayparts.ts";
import {
  resolveChannelProgramming,
  type ResolvedProgramming,
} from "../content/sources/index.ts";
import { advancesEpisodes, pickerFor } from "./strategies/index.ts";

/** Slots shorter than this are almost certainly a bad probe, not real content. */
const MIN_DURATION_MS = 60_000;
/** Give up on a generation pass rather than hammering a broken addon forever. */
const MAX_CONSECUTIVE_FAILURES = 8;
/**
 * Programs resolved at once. Each one costs a debrid lookup plus a remote ffprobe —
 * roughly 10 seconds of almost pure waiting — so doing them sequentially makes a cold
 * channel take many minutes to become watchable. They are independent, so they overlap.
 */
const RESOLVE_BATCH = 6;
/** How long a caller will wait for the schedule to reach a given moment. */
const COVERAGE_TIMEOUT_MS = 90_000;
/** Ceiling on resolving one program: indexer lookup, debrid calls, and a remote probe. */
const SLOT_TIMEOUT_MS = 120_000;
/**
 * Assumed program length while selecting a batch, before real durations are known.
 * Only affects which daypart a slot is attributed to near a block boundary; the actual
 * timeline is laid out from measured durations.
 */
const TYPICAL_PROGRAM_MS = 30 * 60_000;

interface Selection {
  ref: ContentRef;
  daypart: string | null;
  blockId: string | null;
  strategy: ChannelDef["strategy"];
  /** Advances the title rotation even when this particular title is unavailable. */
  slotKey: string;
  /** Counter keys this pick consumed, applied only once the program is really scheduled. */
  bumps: string[];
}

interface CounterCursor {
  peek(key: string): number;
  bump(key: string): void;
}

export interface SchedulePreviewProgram {
  ref: ContentRef;
  title: string;
  start: number;
  duration: number;
  durationSource: "measured" | "estimated" | "assumed";
  daypart: string | null;
  strategy: ChannelDef["strategy"];
}

export interface SchedulePreview {
  start: number;
  until: number;
  programs: SchedulePreviewProgram[];
  warnings: string[];
}

/**
 * Counter values held in memory while a batch is being selected.
 *
 * Selection must be free of side effects: a batch is chosen against *estimated* start
 * times, and any pick whose real time lands in a different daypart is thrown away. If
 * the counters had already been written, discarding a pick would skip an episode that
 * never aired.
 */
class PendingCounters {
  private readonly delta = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly channelId: string,
  ) {}

  peek(key: string): number {
    return this.db.counter(this.channelId, key) + (this.delta.get(key) ?? 0);
  }

  bump(key: string): void {
    this.delta.set(key, (this.delta.get(key) ?? 0) + 1);
  }

  /** Writes a single selection's counters through, once it is definitely airing. */
  commit(bumps: readonly string[]): void {
    for (const key of bumps) this.db.nextCounter(this.channelId, key);
  }
}

/** Fresh, in-memory counters for a draft preview. Nothing reaches SQLite. */
class PreviewCounters implements CounterCursor {
  private readonly values = new Map<string, number>();

  peek(key: string): number {
    return this.values.get(key) ?? 0;
  }

  bump(key: string): void {
    this.values.set(key, this.peek(key) + 1);
  }
}

function isRefreshable(resolver: StreamResolver): resolver is RefreshableResolver {
  return typeof (resolver as RefreshableResolver).refresh === "function";
}

function isPreparatory(resolver: StreamResolver): resolver is PreparatoryResolver {
  return typeof (resolver as PreparatoryResolver).prepare === "function";
}

function isFailover(resolver: StreamResolver): resolver is FailoverResolver {
  return typeof (resolver as FailoverResolver).invalidate === "function";
}

/** Collapses a content list to one entry per title, preserving weights. */
function dedupeTitles(content: readonly ContentRef[]): ContentRef[] {
  const seen = new Map<string, ContentRef>();
  for (const entry of content) {
    const key = `${entry.type}:${entry.id}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

/** Rejects if the promise has not settled in time, so callers can never wait forever. */
function guard<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export class ScheduleGenerator {
  /** Signed provider links are capabilities; keep them off disk by default. */
  private readonly ephemeralUrls = new Map<string, { url: string; expiresAt: number }>();
  private readonly log: Logger;
  private readonly poolCache = new Map<string, ContentRef[]>();
  private loggedPool = false;
  private generating: Promise<void> | null = null;
  private requestedUntil = 0;
  private disposed = false;
  private lastFailure: string | null = null;
  private readonly waiters = new Set<{ untilMs: number; resolve: () => void }>();

  constructor(
    private readonly channel: ChannelDef,
    private readonly db: Db,
    private readonly cinemeta: Cinemeta,
    private readonly resolver: StreamResolver,
    private readonly config: Config,
    parentLog = logger("schedule"),
  ) {
    this.log = parentLog.child(channel.id);
  }

  /**
   * Every episode of every series in a content list, flattened. This is what `shuffle`
   * draws from, so a channel plays each individual episode once before repeating any.
   */
  async episodePool(content: readonly ContentRef[]): Promise<ContentRef[]> {
    const cacheKey = content.map(refKey).join("|");
    const cached = this.poolCache.get(cacheKey);
    if (cached) return cached;

    const expanded: ContentRef[] = [];
    for (const entry of content) {
      expanded.push(...(await this.cinemeta.expand(entry)));
    }

    // Duplicates would break the no-repeat guarantee the shuffle cycle provides.
    const seen = new Set<string>();
    const pool = expanded.filter((ref) => {
      const key = refKey(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.poolCache.set(cacheKey, pool);
    return pool;
  }

  /** Ordered episode list for a series, used to walk it sequentially. */
  private async episodesOf(seriesId: string): Promise<ContentRef[]> {
    return this.episodePool([{ type: "series", id: seriesId }]);
  }

  /**
   * The channel's content with any smart source resolved in. Everything downstream —
   * pools, dayparts, selection — works from this rather than the raw config, so a rule
   * channel behaves exactly like a hand-picked one once populated.
   */
  private async programming(): Promise<ResolvedProgramming> {
    return resolveChannelProgramming(this.channel, this.db, this.config);
  }

  /** Kept for callers that just want to know a channel has usable content. */
  async contentPool(programming?: ResolvedProgramming): Promise<ContentRef[]> {
    const resolved = programming ?? await this.programming();
    const pool = await this.episodePool(resolved.defaultContent);
    if (!this.loggedPool) {
      this.loggedPool = true;
      this.log.info(
        `pool: ${pool.length} programs` +
          (this.channel.source ? ` (source: ${this.channel.source.kind})` : "") +
          (this.channel.pools.length ? ` (${this.channel.pools.length} named pools)` : ""),
      );
    }
    return pool;
  }

  /**
   * Chooses what airs in a slot beginning at `startMs`.
   *
   * Selection is two-level for the stateful strategies: pick a *title*, then walk that
   * series to its next episode. `shuffle` instead draws directly from the flattened
   * episode pool, which is the Phase 1 behaviour and gives the strongest mixing.
   */
  private async selectForSlot(
    startMs: number,
    pending: CounterCursor,
    programming?: ResolvedProgramming,
  ): Promise<Selection | null> {
    const resolved = programming ?? await this.programming();
    const block = activeBlock(
      this.channel,
      new Date(startMs),
      resolved.defaultContent,
      resolved.pools,
    );
    const pick = pickerFor(block.strategy);

    // Each block keeps its own slot position so its cycle is independent of the others.
    const slotKey = `slot:${block.id ?? "default"}`;
    const slotIndex = pending.peek(slotKey);
    const bumps = [slotKey];

    const finish = (ref: ContentRef): Selection => {
      for (const key of bumps) pending.bump(key);
      return {
        ref,
        daypart: block.name,
        blockId: block.id,
        strategy: block.strategy,
        slotKey,
        bumps,
      };
    };

    if (!advancesEpisodes(block.strategy) && block.strategy !== "weighted") {
      const pool = await this.episodePool(block.content);
      if (pool.length === 0) return null;
      return finish(pick(pool, this.channel.seed, slotIndex));
    }

    // Title-level pools: a 200 episode sitcom should not crowd out a single film,
    // which is exactly what happens when everything competes at episode level.
    const titles = dedupeTitles(block.content);
    if (titles.length === 0) return null;

    const title = pick(titles, this.channel.seed, slotIndex);
    if (title.type === "movie" || title.episode !== undefined) return finish(title);

    const episodes = await this.episodesOf(title.id);
    if (episodes.length === 0) return null;

    // Progress is per channel and per series, so each show advances at its own pace and
    // survives a restart. Without persistence a sequential channel replays episode one.
    const episodeKey = `ep:${title.id}`;
    const position = pending.peek(episodeKey);
    bumps.push(episodeKey);
    return finish(episodes[position % episodes.length]!);
  }

  /**
   * Projects a draft lineup without resolving streams or changing persistent schedule state.
   * Selection is the production selection path above; only durations are best-effort until
   * the saved channel performs its TorBox-backed probe.
   */
  async preview(start: number, until: number): Promise<SchedulePreview> {
    const warnings = new Set<string>();
    const programs: SchedulePreviewProgram[] = [];
    const counters = new PreviewCounters();
    let cursor = start;
    const programming = await this.programming();

    // Resolve and expand once up front so an empty rule fails clearly instead of producing
    // hundreds of repeated selection attempts.
    if ((await this.contentPool(programming)).length === 0) {
      return { start, until, programs, warnings: ["This channel has no matching content."] };
    }

    for (let slot = 0; cursor < until && slot < 500; slot++) {
      const selection = await this.selectForSlot(cursor, counters, programming);
      if (!selection) {
        warnings.add("A programming block has no usable content.");
        break;
      }

      const key = refKey(selection.ref);
      const [probe, info] = [
        this.db.getProbe(key),
        await this.cinemeta.titleInfo(selection.ref).catch(() => null),
      ];

      let duration = TYPICAL_PROGRAM_MS;
      let durationSource: SchedulePreviewProgram["durationSource"] = "assumed";
      if (probe && probe.duration_ms >= MIN_DURATION_MS) {
        duration = probe.duration_ms;
        durationSource = "measured";
      } else if (info?.estimatedDurationMs && info.estimatedDurationMs >= MIN_DURATION_MS) {
        duration = info.estimatedDurationMs;
        durationSource = "estimated";
      } else {
        warnings.add("Some runtimes are unknown and are shown as 30-minute estimates.");
      }

      programs.push({
        ref: selection.ref,
        title: info?.name ?? key,
        start: cursor,
        duration,
        durationSource,
        daypart: selection.daypart,
        strategy: selection.strategy,
      });
      cursor += duration;
    }

    if (cursor < until) warnings.add("Preview stopped before covering the requested window.");
    if (programs.some((p) => p.durationSource !== "measured")) {
      warnings.add("Estimated runtimes can move programs near daypart boundaries after saving.");
    }

    return { start, until, programs, warnings: [...warnings] };
  }

  /**
   * Extends the timeline so it covers at least the configured horizon. Concurrent
   * callers share one pass, since both the addon layer and the feed can trigger this.
   *
   * On a cold channel this takes minutes, so almost nothing should await it — use
   * `ensureCoverage` to wait for a specific moment, or fire this and read whatever
   * the timeline already holds.
   */
  /**
   * Retires this generator. A replacement has taken over the channel, so any fill still
   * running must stop writing: two generators appending to one timeline both read the
   * same end point and duplicate every program between them.
   */
  dispose(): void {
    this.disposed = true;
    this.releaseWaiters(Infinity);
  }

  ensureHorizon(now = Date.now()): Promise<void> {
    return this.ensureUntil(now + this.config.scheduleHorizonHours * 3600_000, now);
  }

  private ensureUntil(untilMs: number, now = Date.now()): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requestedUntil = Math.max(this.requestedUntil, untilMs, now + 1);
    if (this.generating) return this.generating;
    this.generating = this.fill(now)
      .catch((err) => this.log.error("schedule generation failed", err))
      .finally(() => {
        this.generating = null;
        // Nothing more is coming; stop anyone still waiting from hanging until timeout.
        this.releaseWaiters(Infinity);
      });
    return this.generating;
  }

  /**
   * Resolves once the timeline covers `untilMs`. This is what a viewer tuning into a
   * cold channel waits on: the first few programs, not the whole 24 hour horizon.
   */
  async ensureCoverage(untilMs: number, timeoutMs = COVERAGE_TIMEOUT_MS): Promise<boolean> {
    const end = this.db.timelineEnd(this.channel.id).endMs;
    if (end !== null && end > untilMs) {
      return true;
    }

    void this.ensureUntil(untilMs, Date.now());

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);

      const waiter = {
        untilMs,
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      this.waiters.add(waiter);
    });
  }

  private releaseWaiters(coveredUntilMs: number): void {
    for (const waiter of this.waiters) {
      if (coveredUntilMs > waiter.untilMs) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  private async fill(now: number): Promise<void> {
    const programming = await this.programming();
    const pool = await this.contentPool(programming);
    if (pool.length === 0) {
      this.log.error("channel has no playable content; check the ids in channels.json");
      return;
    }

    // Old programs are history, not schedule. Keep a short tail so a viewer who is
    // slightly behind the live edge can still be described by the guide.
    this.db.pruneBefore(this.channel.id, now - 6 * 60 * 60 * 1000);

    let { endMs, lastSlot } = this.db.timelineEnd(this.channel.id);

    // A brand new channel, or one whose timeline ran dry while nobody was watching,
    // starts airing from this moment rather than back-filling the past.
    let cursor = endMs && endMs > now ? endMs : now;
    let slot = (lastSlot ?? -1) + 1;

    let failures = 0;
    let added = 0;

    while (cursor < this.requestedUntil && failures < MAX_CONSECUTIVE_FAILURES && !this.disposed) {
      // Selection depends on when a slot airs, and each slot's start depends on the
      // durations of the ones before it. Durations are only known after resolving, so
      // the batch is selected against an estimated clock and laid out for real after.
      const pending = new PendingCounters(this.db, this.channel.id);
      const selections: (Selection | null)[] = [];
      let estimate = cursor;
      for (let i = 0; i < RESOLVE_BATCH; i++) {
        const selection = await this.selectForSlot(estimate, pending, programming);
        selections.push(selection);
        // Prefer a real measured duration over the generic guess: it keeps the estimated
        // clock close to the true one, so batches rarely straddle a daypart boundary.
        estimate += selection
          ? this.db.getProbe(refKey(selection.ref))?.duration_ms ?? TYPICAL_PROGRAM_MS
          : TYPICAL_PROGRAM_MS;
      }

      const slots = selections.map((_, i) => slot + i);
      const resolved = await Promise.all(
        selections.map((selection, i) =>
          selection === null
            ? Promise.resolve(null)
            : // Bounded so a single unresponsive lookup cannot stall the channel.
              // Without this the whole batch waits forever and the channel silently
              // never fills.
              guard(
                this.resolveSlot(selection.ref, slots[i]!, selection.daypart),
                SLOT_TIMEOUT_MS,
              ).catch((err) => {
                this.log.warn(
                  `slot ${slots[i]} abandoned: ${err instanceof Error ? err.message : err}`,
                );
                return null;
              }),
        ),
      );
      // Resolving takes many seconds; a reload during that window means these rows no
      // longer belong to the live config and must not be written.
      if (this.disposed) return;

      let placed = 0;
      let consumed = 0;
      for (const [i, item] of resolved.entries()) {
        const selection = selections[i];
        if (!selection) {
          consumed++;
          continue;
        }

        // The batch was chosen against estimated start times. Now that the real one is
        // known, check it still belongs to the block it was picked for — otherwise the
        // wrong content airs, and the rest of the batch is only more wrong.
        const realBlock = activeBlock(
          this.channel,
          new Date(cursor),
          programming.defaultContent,
          programming.pools,
        );
        if (realBlock.id !== selection.blockId) {
          this.log.debug(
            `batch truncated at a daypart boundary (expected ${selection.daypart ?? "default"}, ` +
              `now ${realBlock.name ?? "default"})`,
          );
          break;
        }

        consumed++;
        if (!item) {
          // A resolver miss must consume the title position or the next pass selects the
          // same unavailable title forever. Do not consume an episode counter: an episode
          // that never aired still has to remain next for sequential channels.
          pending.commit([selection.slotKey]);
          continue;
        }

        // Counters are written only now, so anything discarded above never consumed an
        // episode and nothing is skipped.
        pending.commit(selection.bumps);

        const row = { ...item, start_ms: cursor };
        if (!this.config.persistResolvedUrls && row.resolved_url && row.url_expires_at) {
          this.rememberUrl(row, row.resolved_url, row.url_expires_at);
          row.resolved_url = null;
          row.url_expires_at = null;
        }
        this.db.insertPrograms([row]);
        this.db.recordAiring(this.channel.id, row.ref_key, row.start_ms);
        cursor += row.duration_ms;
        added++;
        placed++;
        // Anyone waiting to tune in can start as soon as their moment is covered,
        // rather than waiting for the whole horizon to fill.
        this.releaseWaiters(cursor);
      }

      // Failed resolver picks and aired programs are consumed. Picks truncated at a
      // daypart boundary are not: they must be selected again against their true block.
      slot += Math.max(1, consumed);
      if (placed > 0) failures = 0;
      else failures += Math.max(1, consumed);
    }

    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      this.lastFailure =
        `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive unavailable programs`;
      this.log.error(`${this.lastFailure} - check resolver availability and cooldown status`);
    } else if (added > 0) {
      this.lastFailure = null;
    }
    if (added > 0) {
      this.log.info(
        `scheduled ${added} programs through ${new Date(cursor).toLocaleString()}`,
      );
    }
  }

  /** Everything about a slot except where it lands on the timeline. */
  private async resolveSlot(
    ref: ContentRef,
    slot: number,
    daypart: string | null = null,
  ): Promise<Omit<ProgramRow, "id" | "start_ms"> | null> {
    const key = refKey(ref);
    const info = await this.cinemeta.titleInfo(ref);
    const title = info?.name ?? key;

    const knownProbe = this.db.getProbe(key);
    const stream: PreparedStream | null = isPreparatory(this.resolver)
      ? await this.resolver.prepare(ref, !knownProbe)
      : await this.resolver.resolve(ref);
    if (!stream) {
      this.log.warn(`could not resolve ${title}; skipping slot ${slot}`);
      return null;
    }

    // Probe rather than trust Cinemeta's runtime string: the clock is only as accurate
    // as these durations, and errors accumulate across the whole day.
    const measured = knownProbe
      ? knownProbe.duration_ms
      : stream.url
        ? (await probeCached(this.db, key, stream.url))?.durationMs
        : undefined;
    const durationMs = measured ?? info?.estimatedDurationMs ?? 0;

    if (durationMs < MIN_DURATION_MS) {
      this.log.warn(`no usable duration for ${title}; skipping slot ${slot}`);
      return null;
    }

    return {
      channel_id: this.channel.id,
      slot_index: slot,
      duration_ms: durationMs,
      ref_key: key,
      title,
      resolved_url: stream.url,
      url_expires_at: stream.expiresAt,
      daypart,
      torrent_id: stream.torrentId ?? null,
      file_id: stream.fileId ?? null,
    };
  }

  status(): { generating: boolean; lastFailure: string | null } {
    return { generating: this.generating !== null, lastFailure: this.lastFailure };
  }

  /** Re-resolves a link that has expired since generation. Debrid URLs are short lived. */
  async freshUrl(program: ProgramRow): Promise<string | null> {
    const memory = this.ephemeralUrls.get(this.urlKey(program));
    if (memory && memory.expiresAt > Date.now()) return memory.url;
    if (memory) this.ephemeralUrls.delete(this.urlKey(program));

    const stillValid =
      program.resolved_url &&
      program.url_expires_at &&
      program.url_expires_at > Date.now();
    if (stillValid) return program.resolved_url;

    // The file is already known to the debrid service, so ask only for a fresh link.
    // A full re-resolve would repeat discovery, cache-check and add for no benefit.
    if (program.torrent_id !== null && program.file_id !== null && isRefreshable(this.resolver)) {
      const renewed = await this.resolver.refresh(program.torrent_id, program.file_id);
      if (renewed) {
        this.saveUrl(program, renewed);
        return renewed.url;
      }
      this.log.debug(`cheap refresh failed for "${program.title}", falling back`);
    }

    const ref = this.poolRefFor(program.ref_key);
    if (!ref) return program.resolved_url;

    this.log.debug(`re-resolving expired link for "${program.title}"`);
    const stream = await this.resolver.resolve(ref);
    if (!stream) return program.resolved_url;

    this.saveUrl(program, stream);
    return stream.url;
  }

  /**
   * Playback found that this direct link cannot deliver media. Expire it immediately
   * so the next tune-in attempt asks the resolver for a new URL instead of serving the
   * same cached, bad link until its normal TTL elapses.
   */
  invalidateUrl(program: ProgramRow): void {
    const ref = this.poolRefFor(program.ref_key);
    const memory = this.ephemeralUrls.get(this.urlKey(program));
    if (ref && isFailover(this.resolver)) {
      this.resolver.invalidate(ref, memory?.url ?? program.resolved_url ?? undefined);
    }
    this.ephemeralUrls.delete(this.urlKey(program));
    this.db.clearResolved(program.id);
  }

  private saveUrl(
    program: Pick<ProgramRow, "id" | "channel_id" | "start_ms" | "ref_key">,
    stream: ResolvedStream,
  ): void {
    if (this.config.persistResolvedUrls) {
      this.db.setResolved(
        program.id,
        stream.url,
        stream.expiresAt,
        stream.torrentId ?? null,
        stream.fileId ?? null,
      );
      return;
    }
    // Persist only durable identifiers; neither one grants media access without the agent.
    this.db.setResolved(
      program.id,
      null,
      null,
      stream.torrentId ?? null,
      stream.fileId ?? null,
    );
    this.rememberUrl(program, stream.url, stream.expiresAt);
  }

  private rememberUrl(
    program: Pick<ProgramRow, "channel_id" | "start_ms" | "ref_key">,
    url: string,
    expiresAt: number,
  ): void {
    const now = Date.now();
    if (this.ephemeralUrls.size >= 500) {
      for (const [key, value] of this.ephemeralUrls) {
        if (value.expiresAt <= now) this.ephemeralUrls.delete(key);
      }
      while (this.ephemeralUrls.size >= 500) {
        const oldest = this.ephemeralUrls.keys().next().value as string | undefined;
        if (!oldest) break;
        this.ephemeralUrls.delete(oldest);
      }
    }
    this.ephemeralUrls.set(this.urlKey(program), { url, expiresAt });
  }

  private urlKey(program: Pick<ProgramRow, "channel_id" | "start_ms" | "ref_key">): string {
    return `${program.channel_id}:${program.start_ms}:${program.ref_key}`;
  }

  /**
   * Recovers the content ref for a scheduled program so its link can be re-resolved.
   * Parsed from the stored key rather than searched for in a pool, because dayparts mean
   * a program may have come from a content list that is not the channel's default.
   */
  private poolRefFor(key: string): ContentRef | undefined {
    try {
      return parseRefKey(key);
    } catch {
      return undefined;
    }
  }
}
