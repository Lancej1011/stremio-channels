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

export function buildManifest(channels: ChannelDef[], version: string) {
  return {
    id: "community.stremio.channels",
    version,
    name: "Channels",
    description:
      "Cable-style linear TV channels. Each channel runs on a clock, so tuning in " +
      "drops you into whatever is already playing.",
    // "tv" is what makes Stremio present these as live channels rather than as a
    // seekable file with a beginning and an end.
    types: ["tv"],
    resources: ["catalog", "meta", "stream"],
    idPrefixes: [ID_PREFIX],
    catalogs: [
      {
        type: "tv",
        id: "channels",
        name: "Channels",
      },
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}
