import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { channelSchema, type ChannelDef } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("presets");

export const presetSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  /** Previous built-in ids, so renamed generic presets do not look uninstalled. */
  legacyIds: z.array(z.string()).default([]),
  channel: channelSchema,
});

export type Preset = z.infer<typeof presetSchema>;

/**
 * Presets ship beside the compiled output. Resolved relative to this module rather than
 * the working directory, so the server works no matter where it is launched from.
 */
function presetDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "presets"), join(here, "..", "..", "presets")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cache: Preset[] | null = null;

export function loadPresets(): Preset[] {
  if (cache) return cache;

  const dir = presetDir();
  if (!dir) {
    log.warn("no presets directory found");
    cache = [];
    return cache;
  }

  const presets: Preset[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      presets.push(presetSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    } catch (err) {
      // A malformed preset must not take down the whole library.
      log.error(`skipping preset ${file}`, err instanceof Error ? err.message : err);
    }
  }

  log.info(`loaded ${presets.length} presets`);
  cache = presets;
  return cache;
}

export function findPreset(key: string): Preset | undefined {
  return loadPresets().find((p) => p.key === key);
}

/**
 * Copies a preset into a new channel definition. Applying a preset is a starting point,
 * not a link: the result is fully editable and never updates behind the user.
 */
export function instantiate(preset: Preset, overrides: Partial<ChannelDef> = {}): ChannelDef {
  return channelSchema.parse({
    ...structuredClone(preset.channel),
    ...overrides,
  });
}
