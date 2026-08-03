import type { ContentRef } from "../../config.ts";
import { refKey } from "../../config.ts";

/** Mulberry32: small, fast, and identical across runs — which is the whole point here. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x5f;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Fisher-Yates against a seeded PRNG. Pure: same input, same output, always. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Shuffle with memory, expressed as cycles rather than as history lookups.
 *
 * The pool is reshuffled once per cycle and played through in that order, so "never
 * repeat until everything has aired" holds by construction instead of depending on
 * what happens to be in the airings table. It also makes the schedule reproducible:
 * the same channel seed and slot index always yield the same program, which is what
 * lets the timeline be regenerated after a crash without the guide changing.
 */
export function pickForSlot(
  pool: readonly ContentRef[],
  channelSeed: number,
  slotIndex: number,
): ContentRef {
  if (pool.length === 0) throw new Error("cannot pick from an empty pool");

  // A stable pool order is required, otherwise the shuffle input differs between runs
  // (Cinemeta ordering, config edits) and determinism is lost.
  const stable = pool.slice().sort((a, b) => refKey(a).localeCompare(refKey(b)));

  const cycle = Math.floor(slotIndex / stable.length);
  const position = slotIndex % stable.length;
  const order = seededShuffle(stable, hashSeed(channelSeed, cycle));
  return order[position]!;
}
