import type { Db, ProgramRow } from "../db.ts";

export interface NowPlaying {
  program: ProgramRow;
  /** How far into the program the wall clock currently is. This is the whole trick. */
  offsetMs: number;
  /** Time left in the slot; becomes the encoder's -t. */
  remainingMs: number;
}

/**
 * Pure lookup against the persisted timeline. It deliberately has no side effects and
 * no knowledge of ffmpeg, so the schedule can be reasoned about and tested on its own.
 */
export function getNowPlaying(
  db: Db,
  channelId: string,
  atMs: number = Date.now(),
): NowPlaying | null {
  const program = db.programAt(channelId, atMs);
  if (!program) return null;

  const offsetMs = atMs - program.start_ms;
  return {
    program,
    offsetMs,
    remainingMs: program.duration_ms - offsetMs,
  };
}

export interface GuideEntry {
  program: ProgramRow;
  startsAt: Date;
  isNow: boolean;
}

/** The next few programs, for the meta description and any future guide UI. */
export function getGuide(
  db: Db,
  channelId: string,
  atMs: number = Date.now(),
  limit = 5,
): GuideEntry[] {
  return db.programsFrom(channelId, atMs, limit).map((program) => ({
    program,
    startsAt: new Date(program.start_ms),
    isNow: program.start_ms <= atMs && program.start_ms + program.duration_ms > atMs,
  }));
}
