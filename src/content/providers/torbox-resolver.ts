import { refKey, type Config, type ContentRef } from "../../config.ts";
import type { Db } from "../../db.ts";
import { logger } from "../../log.ts";
import {
  combineReleaseLanguage,
  detectReleaseLanguage,
  pickBest,
  type SelectionPrefs,
} from "../quality.ts";
import type { PreparatoryResolver, PreparedStream, ResolvedStream } from "../resolver.ts";
import { IndexerClient, type Candidate } from "./indexer.ts";
import { TorBoxClient } from "./torbox.ts";

const log = logger("torbox-resolver");

/** TorBox opens links for roughly three hours; refresh well before that. */
const LINK_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * How many candidates to cache-check. Availability does not track seeder count, so
 * checking generously matters more than checking cheaply — one request covers 50.
 */
const CANDIDATE_LIMIT = 100;

/**
 * Resolves a program by combining an indexer for discovery with TorBox for delivery.
 *
 * Compared with letting a debrid-configured addon do both, this gives real control over
 * which release airs — actual byte sizes and parsed release names rather than substring
 * matching on a display title — and it removes the addon's redirect hop from playback.
 */
interface CachedBinding {
  torrentId: number;
  fileId: number;
  label: string;
}

const BINDING_CACHE_MS = 30 * 24 * 60 * 60_000;

export class TorBoxResolver implements PreparatoryResolver {
  readonly name = "torbox";
  private readonly torbox: TorBoxClient;
  private readonly indexer: IndexerClient;
  private readonly prefs: SelectionPrefs;

  constructor(apiKey: string, indexerUrl: string, config: Config, private readonly db: Db) {
    this.torbox = new TorBoxClient(apiKey);
    this.indexer = new IndexerClient(indexerUrl);
    this.prefs = {
      qualityPreference: config.qualityPreference,
      maxSizeBytes: config.maxSizeGb ? config.maxSizeGb * 1e9 : undefined,
      avoidHevc: config.encoder === "cpu",
    };
  }

  async verify(): Promise<boolean> {
    return this.torbox.verify();
  }

  /**
   * Renews an expired link for a file already known to TorBox. This is the common case
   * for a long-running channel: the schedule is built hours ahead, links last about
   * three, so most programs need refreshing before they air. One request instead of the
   * four a full re-resolve would cost.
   */
  async refresh(torrentId: number, fileId: number): Promise<ResolvedStream | null> {
    try {
      const url = await this.torbox.downloadLink(torrentId, fileId);
      if (!url) return null;
      return {
        url,
        expiresAt: Date.now() + LINK_TTL_MS,
        torrentId,
        fileId,
        label: "refreshed",
      };
    } catch (err) {
      log.warn(`refresh failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async resolve(ref: ContentRef): Promise<ResolvedStream | null> {
    const prepared = await this.prepare(ref, true);
    return prepared?.url && prepared.expiresAt
      ? { ...prepared, url: prepared.url, expiresAt: prepared.expiresAt }
      : null;
  }

  /**
   * Finds and stores the durable TorBox file identifiers. Opening a short-lived CDN URL
   * is optional, so schedule rows hours in the future do not waste requestdl calls.
   */
  async prepare(ref: ContentRef, needUrl: boolean): Promise<PreparedStream | null> {
    try {
      // v3 invalidates bindings created before account file IDs were remapped after
      // createtorrent. Existing schedule rows can still refresh their durable IDs,
      // while a failed refresh falls through to a correct v3 re-resolution.
      const key = `torbox-binding:v3:${refKey(ref)}`;
      let binding: CachedBinding | null | undefined = this.db.getCached<CachedBinding>(
        key,
        BINDING_CACHE_MS,
      );
      if (!validBinding(binding)) {
        binding = await this.discoverBinding(ref);
        if (!binding) return null;
        this.db.putCached(key, binding);
      }

      if (!needUrl) {
        return {
          url: null,
          expiresAt: null,
          torrentId: binding.torrentId,
          fileId: binding.fileId,
          label: binding.label,
        };
      }

      const url = await this.torbox.downloadLink(binding.torrentId, binding.fileId);
      if (!url) return null;
      return {
        url,
        expiresAt: Date.now() + LINK_TTL_MS,
        torrentId: binding.torrentId,
        fileId: binding.fileId,
        label: binding.label,
      };
    } catch (err) {
      // A failed API call is not the same as "this title is unavailable"; saying so
      // would send the scheduler hunting for other content when the fault is ours.
      log.warn(
        `TorBox error resolving ${describe(ref)}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private async discoverBinding(ref: ContentRef): Promise<CachedBinding | null> {
    const candidates = await this.indexer.candidates(ref);
    if (candidates.length === 0) {
      log.warn(`no torrents found for ${describe(ref)}`);
      return null;
    }

    // Rank first, then ask about cache status: checking every result would be a much
    // larger request for candidates that would never be chosen anyway.
    const ranked = candidates
      .slice()
      .sort((a, b) => b.release.seeders - a.release.seeders)
      .slice(0, CANDIDATE_LIMIT);

    // One request returns cache status *and* contents, so candidates can be judged on
    // what they actually contain before anything is added to the account.
    const cached = await this.torbox.checkCached(ranked.map((c) => c.hash));

    const available: { candidate: Candidate; file: TorBoxFileInfo }[] = [];
    let rejectedForMissingEpisode = 0;

    for (const candidate of ranked) {
      const entry = cached.get(candidate.hash);
      if (!entry) continue;

      const file = chooseFile(entry.files ?? [], candidate, ref);
      if (!file) {
        // A season pack that does not contain this episode used to be discovered only
        // after committing the slot to it. Now it simply loses the ranking.
        rejectedForMissingEpisode++;
        continue;
      }

      // Prefer the file's real byte size over whatever the release name claimed; a pack's
      // total size says nothing about the single episode being aired.
      candidate.release.sizeBytes = file.size || entry.size;
      candidate.release.language = combineReleaseLanguage(
        candidate.release.language,
        detectReleaseLanguage(file.name),
      );
      available.push({ candidate, file });
    }

    if (available.length === 0) {
      log.warn(
        `nothing usable on TorBox for ${describe(ref)} ` +
          `(${ranked.length} checked, ${cached.size} cached, ${rejectedForMissingEpisode} missing the episode)`,
      );
      return null;
    }

    const best = pickBest(available, (a) => a.candidate.release, this.prefs);
    if (!best) {
      log.warn(`all cached releases for ${describe(ref)} were filtered out`);
      return null;
    }

    return this.bindingFor(best.candidate, best.file, ref);
  }

  private async bindingFor(
    candidate: Candidate,
    file: TorBoxFileInfo,
    ref: ContentRef,
  ): Promise<CachedBinding | null> {
    const torrentId = await this.torbox.addMagnet(candidate.hash);
    if (torrentId === null) {
      log.warn(`could not add ${candidate.hash} for ${describe(ref)}`);
      return null;
    }

    const accountFiles = await this.torbox.torrentFiles(torrentId);
    const accountFile = matchingAccountFile(accountFiles, file);
    if (!accountFile) {
      log.warn(`could not map "${file.name}" after adding ${candidate.hash} for ${describe(ref)}`);
      return null;
    }

    return {
      torrentId,
      fileId: accountFile.id,
      label: `${candidate.release.resolution || "?"}p ${gb(file.size)}GB ${candidate.title}`.slice(0, 90),
    };
  }
}

function validBinding(value: CachedBinding | null | undefined): value is CachedBinding {
  return Boolean(
    value &&
      Number.isInteger(value.torrentId) &&
      value.torrentId > 0 &&
      Number.isInteger(value.fileId) &&
      value.fileId >= 0,
  );
}

export interface TorBoxFileInfo {
  id: number;
  name: string;
  size: number;
}

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|mov)$/i;
/** Extras, featurettes and sample files masquerade as the real episode. */
const JUNK = /\b(sample|trailer|extra|featurette|behind.the.scenes|deleted)\b/i;

/**
 * Picks the file to air, or null when this torrent cannot serve the request.
 *
 * Returning null is the important part: for an episode, a torrent that does not contain
 * it is useless, and saying so lets the caller fall through to the next candidate rather
 * than airing whatever happened to be biggest.
 */
export function chooseFile(
  files: readonly TorBoxFileInfo[],
  candidate: Candidate,
  ref: ContentRef,
): TorBoxFileInfo | null {
  const usable = files.filter((f) => VIDEO.test(f.name) && !JUNK.test(f.name));
  const pool = usable.length > 0 ? usable : files.filter((f) => VIDEO.test(f.name));
  if (pool.length === 0) return null;

  if (ref.season !== undefined && ref.episode !== undefined) {
    const s = String(ref.season).padStart(2, "0");
    const e = String(ref.episode).padStart(2, "0");
    const patterns = [
      new RegExp(`s${s}[\\s._-]*e${e}(?!\\d)`, "i"),
      new RegExp(`\\b${ref.season}x${e}(?!\\d)`, "i"),
      new RegExp(`\\bep?[\\s._-]?${e}(?!\\d)`, "i"),
    ];
    for (const pattern of patterns) {
      const hit = pool.find((f) => pattern.test(f.name));
      if (hit) return hit;
    }

    // A single-file torrent named for the show is almost certainly the episode the
    // indexer matched, even when the filename omits the episode number.
    if (pool.length === 1) return pool[0]!;
    return null;
  }

  // The indexer often tells us which file it meant; trust that before guessing.
  if (candidate.fileIdx !== undefined) {
    const byIdx = pool.find((f) => f.id === candidate.fileIdx);
    if (byIdx) return byIdx;
  }

  return pool.reduce((a, b) => (b.size > a.size ? b : a));
}

function describe(ref: ContentRef): string {
  return ref.season !== undefined
    ? `${ref.id} S${ref.season}E${ref.episode}`
    : ref.id;
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

export function matchingAccountFile(
  accountFiles: readonly TorBoxFileInfo[],
  cachedFile: TorBoxFileInfo,
): TorBoxFileInfo | null {
  const wantedPath = normalisePath(cachedFile.name);
  const exact = accountFiles.find((file) => normalisePath(file.name) === wantedPath);
  if (exact) return exact;

  // One response may include a directory while the other exposes only short_name.
  const wantedName = basename(wantedPath);
  const byName = accountFiles.filter((file) => basename(normalisePath(file.name)) === wantedName);
  if (byName.length === 1) return byName[0]!;
  const byNameAndSize = byName.find((file) => file.size === cachedFile.size);
  return byNameAndSize ?? null;
}

function normalisePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}
