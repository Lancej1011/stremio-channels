import type { ContentRef, StrategyName } from "../../config.ts";
import { refKey } from "../../config.ts";
import { pickForSlot, seededShuffle, hashSeed } from "./shuffle.ts";

/**
 * Picks which *title* airs in a slot. Every strategy is a pure function of the pool,
 * the seed and the slot index, which is what keeps a published guide reproducible
 * across restarts and regeneration.
 *
 * Choosing which *episode* of a series to air is separate and stateful; see
 * `episodeAdvance` below.
 */
export type TitlePicker = (
  pool: readonly ContentRef[],
  seed: number,
  slotIndex: number,
) => ContentRef;

/**
 * Expands weights into repeated entries so a weighted pool can reuse the same
 * shuffle-per-cycle machinery. An entry with weight 3 simply appears three times, which
 * preserves the no-repeat-until-exhausted guarantee at the level of a cycle.
 */
export function expandByWeight(pool: readonly ContentRef[]): ContentRef[] {
  const expanded: ContentRef[] = [];
  for (const entry of pool) {
    // Fractional weights are rounded up: an entry the user asked for should never
    // silently vanish from rotation.
    const copies = Math.max(1, Math.round(entry.weight ?? 1));
    for (let i = 0; i < copies; i++) expanded.push(entry);
  }
  return expanded;
}

/**
 * Weighted selection. Identical to shuffle when every weight is 1, so a channel that
 * sets weights on only some entries still behaves sensibly.
 */
export const pickWeighted: TitlePicker = (pool, seed, slotIndex) => {
  const expanded = expandByWeight(pool);

  // Deduplicate the *sort* key, not the entries: pickForSlot sorts by refKey for a
  // stable order, and repeated entries must stay adjacent and countable.
  const stable = expanded
    .slice()
    .sort((a, b) => refKey(a).localeCompare(refKey(b)));

  const cycle = Math.floor(slotIndex / stable.length);
  const position = slotIndex % stable.length;
  return seededShuffle(stable, hashSeed(seed, cycle))[position]!;
};

/**
 * Sequential and shuffle pick titles the same way — randomly, without repeating until
 * the pool is exhausted. They differ only in which episode of a chosen series airs,
 * which the generator handles via stored progress counters.
 */
export const PICKERS: Record<StrategyName, TitlePicker> = {
  shuffle: pickForSlot,
  sequential: pickForSlot,
  weighted: pickWeighted,
};

export function pickerFor(strategy: StrategyName): TitlePicker {
  return PICKERS[strategy] ?? pickForSlot;
}

/** Strategies that walk a series in order rather than picking an episode at random. */
export function advancesEpisodes(strategy: StrategyName): boolean {
  return strategy === "sequential";
}

export { pickForSlot, seededShuffle, hashSeed };
