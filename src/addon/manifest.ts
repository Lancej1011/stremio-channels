import type { ChannelDef } from "../config.ts";

/** Every channel id is namespaced so Stremio routes only our ids back to us. */
export const ID_PREFIX = "chan:";

export function channelIdFromStremioId(id: string): string | null {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : null;
}

export function stremioId(channelId: string): string {
  return `${ID_PREFIX}${channelId}`;
}

/**
 * Stremio's catalog grid renders only an item's name beneath its artwork. Keep the
 * channel recognisable there while adding the current show's name, without letting a
 * long episode title consume both available lines.
 */
export function catalogItemName(channelName: string, nowTitle?: string): string {
  const title = nowTitle?.trim();
  if (!title) return channelName;

  // Cinemeta episode titles use "Show - S01E02 - Episode". Movies and other titles do
  // not have this suffix and pass through unchanged.
  const showName = title.replace(/\s+-\s+S\d{1,3}E\d{1,4}(?:\s+-\s+.*)?$/i, "").trim();
  return `${channelName} • ${showName || title}`;
}

/**
 * Every type the same channel list is published under.
 *
 * "tv" is the honest one: it is what makes Stremio present these as live channels rather
 * than as a seekable file with a beginning and an end, and it is what the desktop and
 * Android TV clients render.
 *
 * "movie" exists only because the mobile clients do not surface a `tv` catalog anywhere in
 * their Board or Discover, so on a phone the addon installs and then appears to do
 * nothing. Publishing the identical channels a second time under a type the mobile grid
 * does render is the available workaround. "movie" rather than "series" because a series
 * meta needs a `videos` list to offer playback, while a movie is a single playable item —
 * which is exactly what a channel is.
 */
export const CATALOG_TYPES = ["tv", "movie"] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export function isCatalogType(value: string): value is CatalogType {
  return (CATALOG_TYPES as readonly string[]).includes(value);
}

export function buildManifest(channels: ChannelDef[], version: string) {
  return {
    id: "community.stremio.channels",
    version,
    name: "Channels",
    description:
      "Cable-style linear TV channels. Each channel runs on a clock, so tuning in " +
      "drops you into whatever is already playing.",
    types: [...CATALOG_TYPES],
    resources: ["catalog", "meta", "stream"],
    idPrefixes: [ID_PREFIX],
    catalogs: CATALOG_TYPES.map((type) => ({
      type,
      id: "channels",
      name: "Channels",
    })),
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}
