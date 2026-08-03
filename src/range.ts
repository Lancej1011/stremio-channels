/**
 * HTTP Range parsing for segment delivery.
 *
 * ExoPlayer's default HTTP data source issues Range requests when it retries a segment,
 * and a server that answers one with a full 200 makes the player re-download from the
 * start or, worse, treat the response as malformed. Desktop players never exercise this
 * path, which is why it went unnoticed.
 *
 * Kept separate from the route so the arithmetic — which is all inclusive-bound
 * off-by-one traps — can be tested without a server.
 */

/** Inclusive byte bounds, matching how HTTP expresses them. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Interprets a Range header against a known file size.
 *
 * - a `ByteRange` means answer 206 with exactly those bytes
 * - `"unsatisfiable"` means answer 416
 * - `null` means answer the whole file with 200, which is always a legal response to a
 *   Range request and is the right fallback for multi-range and malformed headers
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1]!.trim();
  // Multipart ranges need a multipart/byteranges body. Serving the whole file instead is
  // legal and far simpler than getting that encoding right for a case no player uses.
  if (spec.includes(",")) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;

  const [, rawStart = "", rawEnd = ""] = parts;
  if (rawStart === "" && rawEnd === "") return null;

  // An empty file cannot satisfy any range.
  if (size <= 0) return "unsatisfiable";

  if (rawStart === "") {
    // Suffix form: "the last N bytes". A zero-length suffix is unsatisfiable by the spec
    // rather than an empty success.
    const wanted = Number(rawEnd);
    if (wanted <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";

  // An open-ended range runs to the last byte; a closed one is clamped, since a client
  // may legally ask for more than exists.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  // A backwards range is malformed rather than unsatisfiable, so it is ignored.
  if (end < start) return null;

  return { start, end };
}

/** Bytes covered by a range. The +1 is because both bounds are inclusive. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** The Content-Range header value for a 206. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
