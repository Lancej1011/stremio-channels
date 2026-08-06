/**
 * Channel guides as something you can hand to someone else.
 *
 * A shared guide is programming only: which titles air, in what order, under which
 * daypart grid. It says nothing about where the video comes from, because nothing in a
 * channel definition does — the debrid account, API keys and access token all live in
 * `config.json`, and `sourceSchema` carries filter criteria rather than credentials. That
 * separation is what makes this safe to publish, and `buildBundle` re-parses every channel
 * through `channelSchema` on the way out so a field added there later cannot ride along
 * unnoticed.
 *
 * The recipient supplies their own debrid account. Whether a shared channel actually plays
 * for them depends on what their provider has cached, which is why an import is never
 * verified here: a guide referencing something unavailable is still a valid guide, and the
 * scheduler already skips titles it cannot resolve.
 */
import { z } from "zod";
import { channelSchema, type ChannelDef } from "./config.ts";

/** Identifies the payload so a pasted blob of unrelated JSON fails fast and clearly. */
export const SHARE_KIND = "headend.channels";
export const SHARE_VERSION = 1;

/**
 * Bundles are capped well below anything a person would hand-assemble. The limit exists so
 * an import cannot be used to exhaust memory or write a pathological channels.json.
 */
const MAX_CHANNELS = 200;

export const shareBundleSchema = z.object({
  kind: z.literal(SHARE_KIND),
  version: z.literal(SHARE_VERSION),
  /** Informational only; never trusted or used for merge decisions. */
  exportedAt: z.string().optional(),
  note: z.string().max(500).optional(),
  channels: z.array(channelSchema).min(1).max(MAX_CHANNELS),
});

export type ShareBundle = z.infer<typeof shareBundleSchema>;

export type MergeMode = "add" | "replace" | "rename";

export interface MergeResult {
  /** The full channel list to write, already in its final order. */
  channels: ChannelDef[];
  added: string[];
  replaced: string[];
  /** Original id mapped to the one it was given, for `rename`. */
  renamed: { from: string; to: string }[];
}

export class ImportConflictError extends Error {
  constructor(readonly ids: string[]) {
    super(`channel id already in use: ${ids.join(", ")}`);
    this.name = "ImportConflictError";
  }
}

/**
 * Wraps channels for export. Each is re-parsed rather than copied, so the bundle contains
 * exactly the schema's fields and nothing a caller happened to be holding alongside them.
 */
export function buildBundle(channels: ChannelDef[], note?: string): ShareBundle {
  return {
    kind: SHARE_KIND,
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    channels: channels.map((channel) => channelSchema.parse(channel)),
  };
}

/** Parses untrusted input. Throws a ZodError describing what was wrong with it. */
export function parseBundle(input: unknown): ShareBundle {
  return shareBundleSchema.parse(input);
}

/**
 * Folds an imported guide into the existing lineup.
 *
 * `add` refuses to touch anything that already exists, which is the safe default for a
 * guide from someone else. `replace` overwrites in place, keeping position so an updated
 * pack does not reshuffle the list. `rename` is what makes trying a stranger's pack
 * painless: colliding channels arrive alongside yours under a suffixed id.
 */
export function mergeImported(
  existing: readonly ChannelDef[],
  incoming: readonly ChannelDef[],
  mode: MergeMode,
): MergeResult {
  const taken = new Set(existing.map((channel) => channel.id));
  const collisions = incoming.filter((channel) => taken.has(channel.id)).map((c) => c.id);

  if (mode === "add" && collisions.length > 0) throw new ImportConflictError(collisions);

  const result: MergeResult = { channels: [...existing], added: [], replaced: [], renamed: [] };

  for (const channel of incoming) {
    if (!taken.has(channel.id)) {
      result.channels.push(channel);
      result.added.push(channel.id);
      taken.add(channel.id);
      continue;
    }

    if (mode === "replace") {
      const at = result.channels.findIndex((item) => item.id === channel.id);
      result.channels[at] = channel;
      result.replaced.push(channel.id);
      continue;
    }

    // rename
    const id = uniqueId(channel.id, taken);
    result.channels.push({ ...channel, id });
    result.renamed.push({ from: channel.id, to: id });
    taken.add(id);
  }

  return result;
}

/**
 * Finds a free id near the requested one. Ids are a restricted alphabet, so the suffix has
 * to stay within it — `-2`, `-3` and so on rather than anything decorative.
 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  // Avoid turning "scifi-2" into "scifi-2-2" on a second import of the same pack.
  const stem = base.replace(/-\d+$/, "");
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not find a free id for ${base}`);
}
