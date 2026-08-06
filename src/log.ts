const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const threshold = LEVELS.indexOf((process.env.LOG_LEVEL as Level) ?? "info");

let secret: string | undefined;

/**
 * Masks a value everywhere it appears in the log. Used for the access token, which is a
 * URL path segment and so rides along in any stream URL that happens to get logged —
 * including from code written long after this was set up.
 */
export function setRedaction(value: string): void {
  secret = value;
}

function redact(text: string): string {
  return secret ? text.split(secret).join("<token>") : text;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS.indexOf(level) < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(redact(extra === undefined ? `${line}\n` : `${line} ${format(extra)}\n`));
}

function format(extra: unknown): string {
  if (extra instanceof Error) return extra.stack ?? extra.message;
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

export type Logger = ReturnType<typeof logger>;

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
    child: (sub: string) => logger(`${scope}:${sub}`),
  };
}
