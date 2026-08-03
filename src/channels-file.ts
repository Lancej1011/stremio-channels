import { renameSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { channelsFileSchema, type ChannelDef } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("channels-file");

/**
 * Writes channels.json atomically. A partial write would leave the file unparseable and
 * every channel dead on next start, so the new content lands in a temp file and is
 * renamed over the original only once it is complete.
 */
export function writeChannelsFile(path: string, channels: ChannelDef[]): void {
  // Validate before touching disk: a rejected edit must leave the existing file intact.
  channelsFileSchema.parse({ channels });

  const serialized = `${JSON.stringify({ channels }, null, 2)}\n`;
  const temp = `${path}.tmp`;

  // Keep one generation of history; hand-built lineups are tedious to recreate.
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch (err) {
      log.warn("could not write backup", err);
    }
  }

  writeFileSync(temp, serialized, "utf8");
  renameSync(temp, path);
  log.info(`wrote ${channels.length} channels to ${path}`);
}
