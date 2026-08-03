import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "../db.ts";
import { logger } from "../log.ts";

const exec = promisify(execFile);
const log = logger("probe");

export interface ProbeResult {
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  /** Zero-based index among audio streams; ffmpeg maps this as `0:a:N`. */
  audioStreamIndex: number | null;
  audioLanguage: string | null;
}

export interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  tags?: { language?: string; title?: string };
  disposition?: { default?: number };
}

/** English first, then the container default, then the first usable audio stream. */
export function preferredAudioStream(
  streams: readonly ProbedStream[],
): { stream: ProbedStream; index: number; language: string | null } | null {
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  if (audio.length === 0) return null;

  const selected =
    audio.find(hasEnglishTag) ??
    audio.find((stream) => stream.disposition?.default === 1) ??
    audio[0]!;
  return {
    stream: selected,
    index: audio.indexOf(selected),
    language: selected.tags?.language ?? selected.tags?.title ?? null,
  };
}

function hasEnglishTag(stream: ProbedStream): boolean {
  const language = stream.tags?.language?.trim().toLowerCase() ?? "";
  if (/^(eng|en)(?:[-_].*)?$/.test(language) || language === "english") return true;
  return /\b(english|eng)\b/i.test(stream.tags?.title ?? "");
}

/**
 * Reads real duration and codecs from a source. The schedule is a clock, so an
 * approximate runtime is not good enough — a 4 minute error compounds across a day
 * until the guide no longer matches what is on screen.
 *
 * Over HTTPS this only pulls the container header, not the whole file.
 */
export async function probeSource(url: string): Promise<ProbeResult | null> {
  try {
    const { stdout } = await exec(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name:stream_tags=language,title:stream_disposition=default",
        "-of", "json",
        url,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: ProbedStream[];
    };

    const seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      log.warn(`no usable duration for ${short(url)}`);
      return null;
    }

    const video = parsed.streams?.find((s) => s.codec_type === "video");
    const selectedAudio = preferredAudioStream(parsed.streams ?? []);

    return {
      durationMs: Math.round(seconds * 1000),
      videoCodec: video?.codec_name ?? null,
      audioCodec: selectedAudio?.stream.codec_name ?? null,
      hasAudio: Boolean(selectedAudio),
      audioStreamIndex: selectedAudio?.index ?? null,
      audioLanguage: selectedAudio?.language ?? null,
    };
  } catch (err) {
    log.warn(`probe failed for ${short(url)}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Probe results are keyed by content, not by URL, since debrid URLs rotate. */
export async function probeCached(
  db: Db,
  refKey: string,
  url: string,
): Promise<ProbeResult | null> {
  const cached = db.getProbe(refKey);
  if (cached) {
    return {
      durationMs: cached.duration_ms,
      videoCodec: cached.video_codec,
      audioCodec: cached.audio_codec,
      hasAudio: Boolean(cached.audio_codec),
      audioStreamIndex: cached.audio_stream_index ?? null,
      audioLanguage: cached.audio_language ?? null,
    };
  }

  const result = await probeSource(url);
  if (!result) return null;

  db.putProbe({
    ref_key: refKey,
    duration_ms: result.durationMs,
    video_codec: result.videoCodec,
    audio_codec: result.audioCodec,
    audio_stream_index: result.audioStreamIndex,
    audio_language: result.audioLanguage,
    probed_at: Date.now(),
  });
  return result;
}

function short(url: string): string {
  return url.length > 90 ? `${url.slice(0, 90)}...` : url;
}
