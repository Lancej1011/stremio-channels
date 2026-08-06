import { readFileSync } from "node:fs";

/** Reads a secret from a mounted file in preference to an environment variable. */
export function secretFromEnv(name: string, fileName = `${name}_FILE`): string | undefined {
  const path = process.env[fileName]?.trim();
  const value = path ? readFileSync(path, "utf8").trim() : process.env[name]?.trim();
  return value || undefined;
}
