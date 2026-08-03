import type { ChannelDef, ContentRef, DaypartDef, StrategyName, Weekday } from "../config.ts";

/** What a given moment on a channel should be programmed with. */
export interface ActiveBlock {
  /** Stable key for counters, so each block cycles independently. Null is the default. */
  id: string | null;
  name: string | null;
  strategy: StrategyName;
  content: ContentRef[];
}

/** Minutes since local midnight. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function parseTimeOfDay(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * True when `minutes` falls inside the block. A block whose end is not after its start
 * wraps past midnight, so "23:00 to 02:00" covers the late evening *and* the small hours.
 */
export function coversMinute(daypart: DaypartDef, minutes: number): boolean {
  const start = parseTimeOfDay(daypart.start);
  const end = parseTimeOfDay(daypart.end);

  // Equal start and end means the block covers the whole day rather than nothing;
  // an empty block would silently drop the hours it claims.
  if (start === end) return true;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Applies selected-day semantics, anchoring an overnight block to the day it starts. */
export function coversDaypart(daypart: DaypartDef, at: Date): boolean {
  const minutes = minutesOfDay(at);
  if (!coversMinute(daypart, minutes)) return false;
  if (!daypart.days) return true;

  const start = parseTimeOfDay(daypart.start);
  const end = parseTimeOfDay(daypart.end);
  const anchor = new Date(at);
  if (start > end && minutes < end) anchor.setDate(anchor.getDate() - 1);
  return daypart.days.includes(WEEKDAYS[anchor.getDay()]!);
}

/** Merges named pools in selection order without multiplying duplicate airtime. */
export function mergePools(
  poolIds: readonly string[],
  resolvedPools: ReadonlyMap<string, readonly ContentRef[]>,
): ContentRef[] {
  const seen = new Set<string>();
  const merged: ContentRef[] = [];
  for (const id of poolIds) {
    for (const ref of resolvedPools.get(id) ?? []) {
      const key = `${ref.type}:${ref.id}:${ref.season ?? ""}:${ref.episode ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

/**
 * Resolves which programming applies at a moment. The first matching daypart wins, so
 * overlapping blocks are decided by the order they are listed rather than arbitrarily.
 */
export function activeBlock(
  channel: ChannelDef,
  at: Date,
  /**
   * The channel's content after any smart source has been resolved. Passing it keeps
   * dayparts working on a rule-populated channel, where `channel.content` in the config
   * is empty and the real list only exists at runtime.
   */
  resolvedContent: ContentRef[] = channel.content,
  resolvedPools: ReadonlyMap<string, readonly ContentRef[]> = new Map(),
): ActiveBlock {
  for (const [index, daypart] of channel.dayparts.entries()) {
    if (!coversDaypart(daypart, at)) continue;
    return {
      // Index keeps the key stable even if two blocks share a name.
      id: `${index}:${daypart.name}`,
      name: daypart.name,
      strategy: daypart.strategy ?? channel.strategy,
      // A daypart may override only the strategy and keep the channel's content.
      content: daypart.poolIds
        ? mergePools(daypart.poolIds, resolvedPools)
        : daypart.content ?? resolvedContent,
    };
  }

  return {
    id: null,
    name: null,
    strategy: channel.strategy,
    content: channel.defaultPoolIds.length
      ? mergePools(channel.defaultPoolIds, resolvedPools)
      : resolvedContent,
  };
}

/** Human-readable summary for the guide and the UI. */
export function describeBlock(block: ActiveBlock): string {
  return block.name ? `${block.name} (${block.strategy})` : block.strategy;
}
