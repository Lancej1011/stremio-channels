/**
 * HLS playlist generation and inspection.
 *
 * ffmpeg writes a bare *media* playlist. Desktop Stremio copes with being handed one
 * directly, but ExoPlayer wants a master playlist so it can read `CODECS` and decide
 * whether it can play the stream before fetching a segment. Generating the master here
 * rather than with ffmpeg's `-master_pl_name` is deliberate: under `-c copy` from an
 * MPEG-TS input the H.264 extradata is Annex B, so ffmpeg can silently omit the `CODECS`
 * attribute entirely — which would look like success and fix nothing.
 *
 * Everything in this file is pure string work, so it is cheap to test and cannot be the
 * reason a feed fails to start.
 */
import type { Config } from "../config.ts";
import type { CodecString } from "./codecs.ts";
import { parseBitrateKbps } from "./codecs.ts";

/** Filename the master points at, resolved relative to the master's own URL. */
export const MEDIA_PLAYLIST_NAME = "media.m3u8";

/** Peak allowance over the nominal bitrate, covering MPEG-TS packetisation overhead. */
const TS_OVERHEAD = 1.12;

/**
 * A single-variant master playlist.
 *
 * No `EXT-X-MEDIA` audio group: audio is muxed into the same MPEG-TS segments as the
 * video, so declaring a separate audio rendition would describe a stream that does not
 * exist.
 */
export function masterPlaylist(
  codecs: CodecString,
  config: Config,
  /**
   * URI of the media playlist, resolved against the master's own URL. Session-scoped in
   * the server (`s/<sessionId>/media.m3u8`) so each viewer gets their own pipeline; the
   * bare default keeps the playlist usable on its own.
   */
  mediaUri: string = MEDIA_PLAYLIST_NAME,
): string {
  const { width, height, fps } = config.video;
  const averageKbps =
    parseBitrateKbps(config.video.bitrate) + parseBitrateKbps(config.audio.bitrate);
  const peakKbps = Math.ceil(averageKbps * TS_OVERHEAD);

  const attributes = [
    `BANDWIDTH=${peakKbps * 1000}`,
    `AVERAGE-BANDWIDTH=${averageKbps * 1000}`,
    `CODECS="${codecs.combined}"`,
    `RESOLUTION=${width}x${height}`,
    `FRAME-RATE=${fps.toFixed(3)}`,
  ].join(",");

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-STREAM-INF:${attributes}`,
    mediaUri,
    "",
  ].join("\n");
}

export interface MediaPlaylistInfo {
  version: number | null;
  targetDuration: number | null;
  mediaSequence: number | null;
  discontinuitySequence: number | null;
  segmentCount: number;
  /** Total seconds the playlist currently describes — how far behind live a player may fall. */
  windowSeconds: number;
  hasDiscontinuity: boolean;
  hasProgramDateTime: boolean;
  hasEndlist: boolean;
  firstProgramDateTime: string | null;
}

/**
 * Reads back what ffmpeg wrote. Used by the debug endpoint, so a device failure report
 * carries the actual state of the playlist rather than a description of it.
 */
export function parseMediaPlaylist(text: string): MediaPlaylistInfo {
  const lines = text.split("\n").map((line) => line.trim());

  let segmentCount = 0;
  let windowSeconds = 0;
  let firstProgramDateTime: string | null = null;

  for (const line of lines) {
    const extinf = /^#EXTINF:([\d.]+)/.exec(line);
    if (extinf) {
      segmentCount++;
      windowSeconds += Number(extinf[1]);
      continue;
    }
    if (firstProgramDateTime === null && line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      firstProgramDateTime = line.slice("#EXT-X-PROGRAM-DATE-TIME:".length);
    }
  }

  return {
    version: tagNumber(lines, "#EXT-X-VERSION:"),
    targetDuration: tagNumber(lines, "#EXT-X-TARGETDURATION:"),
    mediaSequence: tagNumber(lines, "#EXT-X-MEDIA-SEQUENCE:"),
    discontinuitySequence: tagNumber(lines, "#EXT-X-DISCONTINUITY-SEQUENCE:"),
    segmentCount,
    // Floating point sums of 2.000000 are exact enough, but round anyway so the debug
    // output does not show 23.400000000000002.
    windowSeconds: Math.round(windowSeconds * 1000) / 1000,
    // Anchored so EXT-X-DISCONTINUITY-SEQUENCE, which every live playlist may carry, is
    // not mistaken for an actual discontinuity in the current window.
    hasDiscontinuity: lines.some((line) => line === "#EXT-X-DISCONTINUITY"),
    hasProgramDateTime: firstProgramDateTime !== null,
    hasEndlist: lines.some((line) => line === "#EXT-X-ENDLIST"),
    firstProgramDateTime,
  };
}

function tagNumber(lines: readonly string[], tag: string): number | null {
  const line = lines.find((l) => l.startsWith(tag));
  if (!line) return null;
  const value = Number(line.slice(tag.length));
  return Number.isFinite(value) ? value : null;
}
