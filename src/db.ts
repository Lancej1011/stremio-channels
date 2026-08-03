import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./log.ts";

const log = logger("db");

export interface ProgramRow {
  id: number;
  channel_id: string;
  /** Position in the channel's infinite slot sequence; drives deterministic selection. */
  slot_index: number;
  /** Wall-clock ms at which this program starts on the channel timeline. */
  start_ms: number;
  duration_ms: number;
  ref_key: string;
  title: string;
  /** Resolved seekable URL. Null until resolution succeeds. */
  resolved_url: string | null;
  /** Debrid links expire (TorBox is ~3h), so a stale URL must be re-resolved. */
  url_expires_at: number | null;
  /** Which daypart scheduled this, for the guide. Null means the channel default. */
  daypart: string | null;
  /** Debrid identifiers, so an expired link can be renewed in one request. */
  torrent_id: number | null;
  file_id: number | null;
}

export interface ProbeRow {
  ref_key: string;
  duration_ms: number;
  video_codec: string | null;
  audio_codec: string | null;
  /** Zero-based index among audio streams, suitable for ffmpeg's `0:a:N` selector. */
  audio_stream_index?: number | null;
  /** Raw container language tag for diagnostics; normally `eng` for the preferred track. */
  audio_language?: string | null;
  probed_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS programs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT    NOT NULL,
  slot_index    INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  ref_key       TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  resolved_url  TEXT,
  url_expires_at INTEGER,
  daypart       TEXT,
  torrent_id    INTEGER,
  file_id       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_programs_channel_start ON programs (channel_id, start_ms);

CREATE TABLE IF NOT EXISTS airings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT    NOT NULL,
  ref_key    TEXT    NOT NULL,
  aired_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_airings_channel ON airings (channel_id, aired_at);

CREATE TABLE IF NOT EXISTS probe_cache (
  ref_key     TEXT PRIMARY KEY,
  duration_ms INTEGER NOT NULL,
  video_codec TEXT,
  audio_codec TEXT,
  audio_stream_index INTEGER,
  audio_language TEXT,
  probed_at   INTEGER NOT NULL
);

-- Per-channel counters: episode progress for sequential series, and a slot position
-- per daypart so each block cycles independently of the others.
CREATE TABLE IF NOT EXISTS counters (
  channel_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      INTEGER NOT NULL,
  PRIMARY KEY (channel_id, key)
);

CREATE TABLE IF NOT EXISTS meta_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "channels.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS does not evolve an existing installation. These nullable
  // additions are intentionally migration-safe: a null index on an old audio row tells
  // playback to re-probe it once, then the cache is upgraded in place.
  ensureColumn(db, "probe_cache", "audio_stream_index", "INTEGER");
  ensureColumn(db, "probe_cache", "audio_language", "TEXT");
  log.debug(`opened ${join(dataDir, "channels.db")}`);

  const stmts = {
    insertProgram: db.prepare<
      [string, number, number, number, string, string, string | null, number | null, string | null, number | null, number | null]
    >(
      `INSERT INTO programs (channel_id, slot_index, start_ms, duration_ms, ref_key, title, resolved_url, url_expires_at, daypart, torrent_id, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    programAt: db.prepare(
      `SELECT * FROM programs
        WHERE channel_id = ? AND start_ms <= ? AND start_ms + duration_ms > ?
        LIMIT 1`,
    ),
    programsFrom: db.prepare(
      `SELECT * FROM programs
        WHERE channel_id = ? AND start_ms + duration_ms > ?
        ORDER BY start_ms ASC LIMIT ?`,
    ),
    timelineEnd: db.prepare(
      `SELECT MAX(start_ms + duration_ms) AS end_ms, MAX(slot_index) AS last_slot
         FROM programs WHERE channel_id = ?`,
    ),
    deleteBefore: db.prepare(
      `DELETE FROM programs WHERE channel_id = ? AND start_ms + duration_ms < ?`,
    ),
    deleteChannel: db.prepare(`DELETE FROM programs WHERE channel_id = ?`),
    deleteFrom: db.prepare(`DELETE FROM programs WHERE channel_id = ? AND start_ms >= ?`),
    setResolved: db.prepare(
      `UPDATE programs SET resolved_url = ?, url_expires_at = ?, torrent_id = COALESCE(?, torrent_id),
              file_id = COALESCE(?, file_id) WHERE id = ?`,
    ),
    insertAiring: db.prepare(
      `INSERT INTO airings (channel_id, ref_key, aired_at) VALUES (?, ?, ?)`,
    ),
    airedKeys: db.prepare(`SELECT DISTINCT ref_key FROM airings WHERE channel_id = ?`),
    clearAirings: db.prepare(`DELETE FROM airings WHERE channel_id = ?`),
    getProbe: db.prepare(`SELECT * FROM probe_cache WHERE ref_key = ?`),
    putProbe: db.prepare(
      `INSERT INTO probe_cache
         (ref_key, duration_ms, video_codec, audio_codec, audio_stream_index, audio_language, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref_key) DO UPDATE SET
         duration_ms = excluded.duration_ms,
         video_codec = excluded.video_codec,
         audio_codec = excluded.audio_codec,
         audio_stream_index = excluded.audio_stream_index,
         audio_language = excluded.audio_language,
         probed_at   = excluded.probed_at`,
    ),
    getCounter: db.prepare(`SELECT value FROM counters WHERE channel_id = ? AND key = ?`),
    bumpCounter: db.prepare(
      `INSERT INTO counters (channel_id, key, value) VALUES (?, ?, 1)
       ON CONFLICT(channel_id, key) DO UPDATE SET value = value + 1`,
    ),
    clearCounters: db.prepare(`DELETE FROM counters WHERE channel_id = ?`),
    getMeta: db.prepare(`SELECT * FROM meta_cache WHERE key = ?`),
    putMeta: db.prepare(
      `INSERT INTO meta_cache (key, value, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
    ),
    deleteMeta: db.prepare(`DELETE FROM meta_cache WHERE key = ?`),
  };

  return {
    raw: db,
    close: () => db.close(),

    insertPrograms(
      rows: Omit<ProgramRow, "id">[],
    ): void {
      const tx = db.transaction((items: Omit<ProgramRow, "id">[]) => {
        for (const r of items) {
          stmts.insertProgram.run(
            r.channel_id,
            r.slot_index,
            r.start_ms,
            r.duration_ms,
            r.ref_key,
            r.title,
            r.resolved_url,
            r.url_expires_at,
            r.daypart,
            r.torrent_id,
            r.file_id,
          );
        }
      });
      tx(rows);
    },

    programAt(channelId: string, atMs: number): ProgramRow | undefined {
      return stmts.programAt.get(channelId, atMs, atMs) as ProgramRow | undefined;
    },

    programsFrom(channelId: string, fromMs: number, limit = 20): ProgramRow[] {
      return stmts.programsFrom.all(channelId, fromMs, limit) as ProgramRow[];
    },

    /** End of the generated timeline and the last slot used, for continuing generation. */
    timelineEnd(channelId: string): { endMs: number | null; lastSlot: number | null } {
      const row = stmts.timelineEnd.get(channelId) as {
        end_ms: number | null;
        last_slot: number | null;
      };
      return { endMs: row?.end_ms ?? null, lastSlot: row?.last_slot ?? null };
    },

    pruneBefore(channelId: string, beforeMs: number): void {
      stmts.deleteBefore.run(channelId, beforeMs);
    },

    clearChannel(channelId: string): void {
      stmts.deleteChannel.run(channelId);
    },

    /** Removes this program and everything scheduled after it. */
    dropFrom(channelId: string, fromMs: number): void {
      stmts.deleteFrom.run(channelId, fromMs);
    },

    setResolved(
      programId: number,
      url: string | null,
      expiresAt: number | null,
      torrentId: number | null = null,
      fileId: number | null = null,
    ): void {
      stmts.setResolved.run(url, expiresAt, torrentId, fileId, programId);
    },

    recordAiring(channelId: string, refKey: string, atMs: number): void {
      stmts.insertAiring.run(channelId, refKey, atMs);
    },

    airedKeys(channelId: string): Set<string> {
      const rows = stmts.airedKeys.all(channelId) as { ref_key: string }[];
      return new Set(rows.map((r) => r.ref_key));
    },

    clearAirings(channelId: string): void {
      stmts.clearAirings.run(channelId);
    },

    /** Current value without changing it. Zero when the counter has never been used. */
    counter(channelId: string, key: string): number {
      const row = stmts.getCounter.get(channelId, key) as { value: number } | undefined;
      return row?.value ?? 0;
    },

    /** Returns the value *before* incrementing, so callers get a 0-based position. */
    nextCounter(channelId: string, key: string): number {
      const current = this.counter(channelId, key);
      stmts.bumpCounter.run(channelId, key);
      return current;
    },

    clearCounters(channelId: string): void {
      stmts.clearCounters.run(channelId);
    },

    getProbe(refKey: string): ProbeRow | undefined {
      return stmts.getProbe.get(refKey) as ProbeRow | undefined;
    },

    putProbe(row: ProbeRow): void {
      stmts.putProbe.run(
        row.ref_key,
        row.duration_ms,
        row.video_codec,
        row.audio_codec,
        row.audio_stream_index ?? null,
        row.audio_language ?? null,
        row.probed_at,
      );
    },

    getCached<T>(key: string, maxAgeMs: number): T | undefined {
      const row = stmts.getMeta.get(key) as
        | { value: string; fetched_at: number }
        | undefined;
      if (!row || Date.now() - row.fetched_at > maxAgeMs) return undefined;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return undefined;
      }
    },

    putCached(key: string, value: unknown): void {
      stmts.putMeta.run(key, JSON.stringify(value), Date.now());
    },

    deleteCached(key: string): void {
      stmts.deleteMeta.run(key);
    },
  };
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
