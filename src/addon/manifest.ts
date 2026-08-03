import type { ChannelDef } from "../config.ts";

/** Every channel id is namespaced so Stremio routes only our ids back to us. */
export const ID_PREFIX = "chan:";

export function channelIdFromStremioId(id: string): string | null {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : null;
}

export function stremioId(channelId: string): string {
  return `${ID_PREFIX}${channelId}`;
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
