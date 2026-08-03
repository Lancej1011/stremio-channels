import {
  baseUrl,
  refKey,
  parseRefKey,
  type ChannelDef,
  type Config,
  type ContentRef,
} from "./config.ts";
import { Cinemeta } from "./content/cinemeta.ts";
import { AddonResolver, type StreamResolver } from "./content/resolver.ts";
import { TorBoxResolver } from "./content/providers/torbox-resolver.ts";
import { cooldownRemainingSeconds } from "./content/providers/torbox.ts";
import { probeSource } from "./content/probe.ts";
import { fetchSource } from "./content/sources/index.ts";
import type { Db } from "./db.ts";
import { SessionManager, type NextProgram } from "./feed/supervisor.ts";
import { logger } from "./log.ts";
import { getGuide, getNowPlaying } from "./schedule/clock.ts";
import { ScheduleGenerator, type SchedulePreview } from "./schedule/generator.ts";

const log = logger("channels");
const SCHEDULE_KEEPER_INTERVAL_MS = 5 * 60_000;

/**
 * A slot with less than this left is treated as finished. It must exceed the supervisor's
 * minimum program length, or the supervisor will reject the sliver and show a slate.
 */
const BOUNDARY_EPSILON_MS = 10_000;

/** How often to top up links for what is about to air. */
const LINK_KEEPER_INTERVAL_MS = 10 * 60_000;
/** Refresh a link this far before it expires, rather than waiting for it to lapse. */
const LINK_REFRESH_MARGIN_MS = 25 * 60_000;

export interface ChannelView {
  id: string;
  name: string;
  poster?: string;
  background?: string;
  description: string;
  nowTitle?: string;
}

/**
 * Ties the three halves together: the schedule says what should be on, the clock says
 * how far into it we are, and the feed turns that into video.
 */
export class ChannelService {
  readonly feeds: SessionManager;
  private readonly generators = new Map<string, ScheduleGenerator>();
  private readonly cinemeta: Cinemeta;
  private readonly resolver: StreamResolver | null;

  constructor(
    private channels: ChannelDef[],
    private readonly db: Db,
    private readonly config: Config,
    /** Injectable so an integration test can observe what the feed was asked to air. */
    private readonly feedLog = logger("feed"),
  ) {
    this.cinemeta = new Cinemeta(db);
    this.resolver = buildResolver(config, db);

    for (const channel of channels) {
      this.generators.set(
        channel.id,
        new ScheduleGenerator(
          channel,
          db,
          this.cinemeta,
          this.resolver ?? nullResolver,
          config,
        ),
      );
    }

    this.feeds = new SessionManager(config, (id) => this.programProvider(id), this.feedLog);
  }

  list(): ChannelDef[] {
    return this.channels;
  }

  /**
   * Channel definitions with display names attached to each content entry. The config
   * file stores only IMDb ids, which are unreadable in an editor; names come from the
   * Cinemeta cache so this costs nothing after the first load.
   */
  async listWithNames(): Promise<unknown[]> {
    return this.channelsWithNames(this.channels);
  }

  /** Adds display names to any channel definition, including an unsaved preset draft. */
  async withNames(channel: ChannelDef): Promise<unknown> {
    return (await this.channelsWithNames([channel]))[0];
  }

  /** Resolves shared titles once when several presets are listed together. */
  async channelsWithNames(channels: readonly ChannelDef[]): Promise<unknown[]> {
    const names = new Map<string, string>();

    const resolve = async (entries: readonly ContentRef[]) => {
      await Promise.all(
        entries.map(async (entry) => {
          if (names.has(entry.id)) return;
          const info = await this.cinemeta.titleInfo({ type: entry.type, id: entry.id })
            .catch(() => null);
          if (info?.name) names.set(entry.id, info.name);
        }),
      );
    };

    for (const channel of channels) {
      await resolve(channel.content);
      for (const pool of channel.pools) {
        await resolve(pool.content);
        await resolve(pool.excluded.map((entry) => ({ ...entry })));
      }
      for (const daypart of channel.dayparts) {
        if (daypart.content) await resolve(daypart.content);
      }
    }

    const label = (entry: ContentRef) => ({ ...entry, name: names.get(entry.id) ?? entry.id });
    return channels.map((channel) => ({
      ...channel,
      content: channel.content.map(label),
      pools: channel.pools.map((pool) => ({
        ...pool,
        content: pool.content.map(label),
        excluded: pool.excluded.map(label),
      })),
      dayparts: channel.dayparts.map((d) => ({
        ...d,
        content: d.content?.map(label),
      })),
    }));
  }

  /**
   * Builds a projected lineup for an unsaved definition. Source discovery and Cinemeta
   * metadata are allowed; TorBox resolution, probes, counters and schedule rows are not.
   */
  async previewChannel(
    channel: ChannelDef,
    hours: number,
    start = Date.now(),
  ): Promise<SchedulePreview & { contentCount: number; sourceCount: number }> {
    let sourceCount = 0;
    let effective: ChannelDef;
    if (channel.pools.length) {
      const pools = await Promise.all(channel.pools.map(async (pool) => {
        const matches = pool.source ? await fetchSource(pool.source, this.config, this.db) : [];
        sourceCount += matches.length;
        const excluded = new Set(pool.excluded.map((item) => `${item.type}:${item.id}`));
        const content = uniqueRefs([
          ...pool.content,
          ...matches
            .filter((match) => !excluded.has(`${match.ref.type}:${match.ref.id}`))
            .map((match) => match.ref),
        ]);
        return { ...pool, content, source: undefined };
      }));
      effective = { ...channel, pools };
    } else {
      const matches = channel.source
        ? await fetchSource(channel.source, this.config, this.db)
        : [];
      sourceCount = matches.length;
      effective = {
        ...channel,
        content: uniqueRefs([...channel.content, ...matches.map((match) => match.ref)]),
        source: undefined,
      };
    }
    const generator = new ScheduleGenerator(
      effective,
      this.db,
      this.cinemeta,
      nullResolver,
      this.config,
    );
    const preview = await generator.preview(start, start + hours * 3600_000);
    const allContent = effective.pools.length
      ? effective.pools.flatMap((pool) => pool.content)
      : effective.content;
    const uniqueTitles = new Set(allContent.map((ref) => `${ref.type}:${ref.id}`));
    return {
      ...preview,
      contentCount: uniqueTitles.size,
      sourceCount,
    };
  }

  /**
   * Swaps in an edited channel set without restarting the server.
   *
   * Only channels whose programming actually changed are disturbed: their schedule,
   * counters and running feed are discarded because the old timeline no longer reflects
   * the config. Everything else keeps playing untouched, so editing one channel never
   * interrupts a viewer watching another.
   */
  reload(next: ChannelDef[]): { changed: string[]; removed: string[] } {
    const before = new Map(this.channels.map((c) => [c.id, programmingKey(c)]));
    const after = new Map(next.map((c) => [c.id, programmingKey(c)]));

    const changed = next
      .filter((c) => before.get(c.id) !== after.get(c.id))
      .map((c) => c.id);
    const removed = [...before.keys()].filter((id) => !after.has(id));

    this.channels = next;

    // Only rebuild generators whose programming actually changed. Replacing an unchanged
    // channel's generator would leave its in-flight fill running alongside the new one,
    // and both would append to the same timeline from the same end point.
    for (const id of [...changed, ...removed]) {
      this.generators.get(id)?.dispose();
      this.generators.delete(id);
    }
    for (const channel of next) {
      if (this.generators.has(channel.id)) continue;
      this.generators.set(
        channel.id,
        new ScheduleGenerator(
          channel,
          this.db,
          this.cinemeta,
          this.resolver ?? nullResolver,
          this.config,
        ),
      );
    }

    for (const id of [...changed, ...removed]) this.resetChannel(id);
    if (changed.length || removed.length) {
      log.info(`reloaded: ${changed.length} changed, ${removed.length} removed`);
    }
    return { changed, removed };
  }

  /** Drops a channel's timeline and stops its feed. Used by reload and by regenerate. */
  resetChannel(channelId: string): void {
    this.feeds.stopChannel(channelId, "channel reconfigured");
    this.db.clearChannel(channelId);
    this.db.clearCounters(channelId);
    this.db.clearAirings(channelId);
  }

  /**
   * Drops the currently airing program and moves the channel on. The schedule after this
   * point is rebuilt, since everything downstream would otherwise still be timed against
   * the program that just got cut.
   */
  skipCurrent(channelId: string): boolean {
    const now = getNowPlaying(this.db, channelId);
    if (!now) return false;

    this.db.dropFrom(channelId, now.program.start_ms);
    this.feeds.stopChannel(channelId, "program skipped");
    void this.generators.get(channelId)?.ensureHorizon();
    log.info(`${channelId}: skipped "${now.program.title}"`);
    return true;
  }

  get(id: string): ChannelDef | undefined {
    return this.channels.find((c) => c.id === id);
  }

  /**
   * Confirms the resolver can actually reach its backend. A bad API key would otherwise
   * surface only as channels that mysteriously never have anything scheduled.
   */
  async verifyResolver(): Promise<void> {
    if (this.resolver instanceof TorBoxResolver) {
      const ok = await this.resolver.verify();
      if (ok) log.info("TorBox API key verified");
      else log.error("TorBox rejected the API key - check torboxApiKey in config.json");
    }
  }

  /** Builds one channel's timeline, used after a reset or a config change. */
  async warmUpChannel(channelId: string): Promise<void> {
    await this.generators
      .get(channelId)
      ?.ensureHorizon()
      .catch((err) => log.error(`warm up failed for ${channelId}`, err));
  }

  /**
   * Keeps the currently airing and next program's links valid on every channel.
   *
   * Debrid links last a few hours but the schedule is built a day ahead, so most programs
   * would otherwise need refreshing at the moment someone tunes in — putting a debrid
   * round trip directly in the path of pressing play. Doing it on a timer moves that cost
   * off the critical path entirely.
   */
  async refreshUpcomingLinks(): Promise<void> {
    for (const channel of this.channels) {
      const gen = this.generators.get(channel.id);
      if (!gen) continue;

      // Only the next couple of slots matter; refreshing the whole day would be a large
      // burst against a rate limited API for links that expire before they are used.
      for (const entry of getGuide(this.db, channel.id, Date.now(), 2)) {
        const expiresAt = entry.program.url_expires_at;
        if (expiresAt && expiresAt - Date.now() > LINK_REFRESH_MARGIN_MS) continue;
        await gen.freshUrl(entry.program).catch(() => null);
      }
    }
  }

  startLinkKeeper(): NodeJS.Timeout {
    void this.refreshUpcomingLinks();
    const timer = setInterval(() => {
      void this.refreshUpcomingLinks().catch((err) => log.error("link keeper failed", err));
    }, LINK_KEEPER_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  /** Warms every channel's timeline so the catalog has something to describe. */
  async warmUp(): Promise<void> {
    // Give every channel its current slot before spending minutes filling any one
    // channel's full guide. Then extend horizons one at a time to avoid a TorBox burst.
    for (const [id, gen] of this.generators) {
      await gen
        .ensureCoverage(Date.now() + 1)
        .catch((err) => log.error(`current-slot warm up failed for ${id}`, err));
    }
    await this.maintainSchedules();
  }

  async maintainSchedules(): Promise<void> {
    for (const [id, gen] of this.generators) {
      await gen.ensureHorizon().catch((err) => log.error(`horizon fill failed for ${id}`, err));
    }
  }

  startScheduleKeeper(): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.maintainSchedules().catch((err) => log.error("schedule keeper failed", err));
    }, SCHEDULE_KEEPER_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  provisioning(channelId: string): {
    state: "provisioning" | "ready" | "waiting-for-torbox" | "error";
    scheduledThrough: number | null;
    targetThrough: number;
    progress: number;
    detail: string | null;
  } {
    const now = Date.now();
    const targetThrough = now + this.config.scheduleHorizonHours * 3600_000;
    const scheduledThrough = this.db.timelineEnd(channelId).endMs;
    const generator = this.generators.get(channelId)?.status();
    const coveredMs = Math.max(0, (scheduledThrough ?? now) - now);
    const progress = Math.min(1, coveredMs / Math.max(1, targetThrough - now));
    const hasCurrent = scheduledThrough !== null && scheduledThrough > now;
    const cooldown = cooldownRemainingSeconds();

    if (hasCurrent) {
      return { state: "ready", scheduledThrough, targetThrough, progress, detail: null };
    }
    if (cooldown > 0) {
      return {
        state: "waiting-for-torbox",
        scheduledThrough,
        targetThrough,
        progress,
        detail: `retrying after TorBox cooldown (${cooldown}s)`,
      };
    }
    if (generator?.lastFailure) {
      return {
        state: "error",
        scheduledThrough,
        targetThrough,
        progress,
        detail: generator.lastFailure,
      };
    }
    return {
      state: "provisioning",
      scheduledThrough,
      targetThrough,
      progress,
      detail: generator?.generating ? "preparing the first playable slot" : "queued for preparation",
    };
  }

  streamUrl(channelId: string): string {
    return `${baseUrl(this.config)}/ch/${channelId}/live.m3u8`;
  }

  /**
   * What the supervisor calls at every program boundary. It reads the wall clock each
   * time, so a slow link resolution shifts the next program's start offset instead of
   * accumulating as drift against the published schedule.
   */
  private programProvider(channelId: string) {
    return async (): Promise<NextProgram | null> => {
      const gen = this.generators.get(channelId);
      if (!gen) return null;

      // Wait only for the current moment to be scheduled. On a cold channel the full
      // horizon takes minutes to build, and a viewer should not wait for all of it.
      await gen.ensureCoverage(Date.now());

      let now = getNowPlaying(this.db, channelId);

      // An encoder can finish a few hundred milliseconds before its slot formally ends,
      // which leaves the current program "on" with almost no time left. Reporting that
      // sliver makes the supervisor fill the remainder with a slate, so every single
      // transition would cost a slate's worth of dead air. Step over the boundary
      // instead and start the next program at its beginning.
      if (now && now.remainingMs < BOUNDARY_EPSILON_MS) {
        const justAfter = now.program.start_ms + now.program.duration_ms + 1;
        now = getNowPlaying(this.db, channelId, justAfter);
      }

      if (!now) {
        log.warn(`${channelId}: nothing scheduled right now`);
        return null;
      }

      const url = await gen.freshUrl(now.program);
      if (!url) {
        log.warn(`${channelId}: no link for "${now.program.title}"`);
        return null;
      }

      let probe = this.db.getProbe(now.program.ref_key);
      // Rows created before language-aware probing know that audio exists but not which
      // track is English. Upgrade those lazily when the title next airs, using the URL
      // playback already needed, instead of opening debrid links while browsing.
      if (probe?.audio_codec && probe.audio_stream_index == null) {
        const upgraded = await probeSource(url);
        if (upgraded) {
          this.db.putProbe({
            ref_key: now.program.ref_key,
            duration_ms: upgraded.durationMs,
            video_codec: upgraded.videoCodec,
            audio_codec: upgraded.audioCodec,
            audio_stream_index: upgraded.audioStreamIndex,
            audio_language: upgraded.audioLanguage,
            probed_at: Date.now(),
          });
          probe = this.db.getProbe(now.program.ref_key);
        }
      }
      return {
        title: now.program.title,
        source: {
          url,
          offsetSeconds: Math.max(0, now.offsetMs / 1000),
          durationSeconds: Math.max(0, now.remainingMs / 1000),
          // Assume audio when unprobed; a wrong guess costs one failed program, while
          // silently dropping audio would be far harder to notice.
          hasAudio: probe ? Boolean(probe.audio_codec) : true,
          audioStreamIndex: probe?.audio_stream_index ?? undefined,
        },
      };
    };
  }

  /** Catalog and meta view: what is on now, what is next, and artwork to show. */
  async view(channelId: string): Promise<ChannelView | null> {
    const channel = this.get(channelId);
    if (!channel) return null;

    // Catalog and meta must answer immediately: Stremio gives an addon seconds, not
    // minutes, and a cold channel is still generating. Kick generation off and describe
    // whatever the timeline already holds.
    void this.generators.get(channelId)?.ensureHorizon();

    const guide = getGuide(this.db, channelId, Date.now(), 3);
    const current = guide.find((g) => g.isNow);
    const upcoming = guide.filter((g) => !g.isNow);

    const lines: string[] = [];
    if (current) {
      lines.push(`▶ Now: ${current.program.title}`);
      const endsAt = new Date(current.program.start_ms + current.program.duration_ms);
      lines.push(`   until ${timeOfDay(endsAt)}`);
    } else {
      lines.push("▶ Off air - nothing scheduled");
    }
    for (const entry of upcoming) {
      lines.push(`   ${timeOfDay(entry.startsAt)}  ${entry.program.title}`);
    }
    if (channel.description) lines.push("", channel.description);

    // Fall back to the current program's artwork so a channel looks alive even when
    // channels.json specifies no poster of its own.
    let poster = channel.poster;
    let background: string | undefined;
    if (current) {
      const info = await this.cinemeta
        .titleInfo(parseRefKey(current.program.ref_key))
        .catch(() => null);
      poster ??= info?.poster;
      background = info?.background;
    }

    return {
      id: channel.id,
      name: channel.name,
      poster,
      background,
      description: lines.join("\n"),
      nowTitle: current?.program.title,
    };
  }
}

/**
 * Direct TorBox is preferred when a key is present: it picks releases on real byte sizes
 * and parsed release names rather than substring matching, and it drops the addon's
 * redirect hop from playback. A pre-configured debrid addon remains the simpler path.
 */
function buildResolver(config: Config, db: Db): StreamResolver | null {
  if (config.torboxApiKey) {
    log.info(`resolving via TorBox directly (indexer: ${config.indexerUrl})`);
    return new TorBoxResolver(config.torboxApiKey, config.indexerUrl, config, db);
  }
  if (config.streamAddonUrl) {
    log.info("resolving via configured stream addon");
    return new AddonResolver(config.streamAddonUrl, config);
  }
  log.error(
    "No resolver configured: channels will have nothing to air. Set torboxApiKey, " +
      "or streamAddonUrl pointing at a stream addon that has your debrid key.",
  );
  return null;
}

/** Stands in when nothing is configured, so startup fails loudly but not fatally. */
const nullResolver: StreamResolver = {
  name: "none",
  resolve: async () => null,
};

/**
 * Fingerprint of everything that affects what a channel airs. Name and poster changes
 * deliberately do not count, so renaming a channel does not interrupt playback.
 */
function programmingKey(channel: ChannelDef): string {
  return JSON.stringify([
    channel.strategy,
    channel.seed,
    channel.content,
    channel.source,
    channel.refreshHours,
    channel.pools,
    channel.defaultPoolIds,
    channel.dayparts,
  ]);
}

function uniqueRefs(refs: readonly ContentRef[]): ContentRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export { refKey };
