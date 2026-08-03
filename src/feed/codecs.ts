/**
 * RFC 6381 codec strings for the HLS master playlist.
 *
 * ExoPlayer (Stremio on Android TV and Fire TV) decides whether it can play a stream from
 * the `CODECS` attribute *before* fetching a segment, so an absent string leaves it
 * guessing and a wrong one makes it refuse outright. Both are worse than being accurate.
 *
 * Two sources of truth, in that order of preference:
 *
 * - `measureCodecs` reads the bytes ffmpeg actually wrote. Truthful by construction, and
 *   the only option that survives a hardware encoder doing something unexpected.
 * - `computeCodecs` derives the string from settings. Needed because the master playlist
 *   must be servable before the first segment exists.
 *
 * They should agree; when they do not, the measurement wins and the disagreement is worth
 * shouting about, because it means the encoder is not doing what the config asked.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../log.ts";

const exec = promisify(execFile);
const log = logger("codecs");

export type H264Profile = "high" | "main";

export interface CodecString {
  /** e.g. `avc1.640028` */
  video: string;
  /** e.g. `mp4a.40.2` */
  audio: string;
  /** Both, comma separated, as the CODECS attribute wants them. */
  combined: string;
}

export interface CodecOptions {
  width: number;
  height: number;
  fps: number;
  /** Video bitrate in kbps. */
  bitrateKbps: number;
  profile: H264Profile;
  /** `"auto"` derives the level from the geometry; anything else pins it. */
  level: string;
}

/**
 * AAC-LC, always. `audioArgs` in hwaccel.ts requests ffmpeg's native `aac` encoder, which
 * only emits Low Complexity (audio object type 2). Asserted by the integration suite
 * rather than merely assumed here.
 */
export const AAC_LC = "mp4a.40.2";

/**
 * profile_idc and the constraint_set byte that goes with it.
 *
 * The constraint byte is the part most often got wrong. Main is conventionally `4d40`,
 * not `4d00`, because encoders set constraint_set1_flag when they promise Main
 * compatibility — which is why this is measured rather than reconstructed from ffprobe's
 * profile *name* wherever a real segment is available.
 */
export function h264ProfileBytes(profile: H264Profile): [number, number] {
  return profile === "main" ? [0x4d, 0x40] : [0x64, 0x00];
}

/** H.264 Annex A table A-1, in ascending order. Bitrates are the Main/Baseline figures. */
const LEVELS: { idc: number; maxMacroblocks: number; maxMacroblocksPerSecond: number; maxKbps: number }[] = [
  { idc: 10, maxMacroblocks: 99, maxMacroblocksPerSecond: 1485, maxKbps: 64 },
  { idc: 11, maxMacroblocks: 396, maxMacroblocksPerSecond: 3000, maxKbps: 192 },
  { idc: 12, maxMacroblocks: 396, maxMacroblocksPerSecond: 6000, maxKbps: 384 },
  { idc: 13, maxMacroblocks: 396, maxMacroblocksPerSecond: 11880, maxKbps: 768 },
  { idc: 20, maxMacroblocks: 396, maxMacroblocksPerSecond: 11880, maxKbps: 2000 },
  { idc: 21, maxMacroblocks: 792, maxMacroblocksPerSecond: 19800, maxKbps: 4000 },
  { idc: 22, maxMacroblocks: 1620, maxMacroblocksPerSecond: 20250, maxKbps: 4000 },
  { idc: 30, maxMacroblocks: 1620, maxMacroblocksPerSecond: 40500, maxKbps: 10000 },
  { idc: 31, maxMacroblocks: 3600, maxMacroblocksPerSecond: 108000, maxKbps: 14000 },
  { idc: 32, maxMacroblocks: 5120, maxMacroblocksPerSecond: 216000, maxKbps: 20000 },
  { idc: 40, maxMacroblocks: 8192, maxMacroblocksPerSecond: 245760, maxKbps: 20000 },
  { idc: 41, maxMacroblocks: 8192, maxMacroblocksPerSecond: 245760, maxKbps: 50000 },
  { idc: 42, maxMacroblocks: 8704, maxMacroblocksPerSecond: 522240, maxKbps: 50000 },
  { idc: 50, maxMacroblocks: 22080, maxMacroblocksPerSecond: 589824, maxKbps: 135000 },
  { idc: 51, maxMacroblocks: 36864, maxMacroblocksPerSecond: 983040, maxKbps: 240000 },
  { idc: 52, maxMacroblocks: 36864, maxMacroblocksPerSecond: 2073600, maxKbps: 240000 },
  { idc: 60, maxMacroblocks: 139264, maxMacroblocksPerSecond: 4177920, maxKbps: 240000 },
  { idc: 61, maxMacroblocks: 139264, maxMacroblocksPerSecond: 8355840, maxKbps: 480000 },
  { idc: 62, maxMacroblocks: 139264, maxMacroblocksPerSecond: 16711680, maxKbps: 800000 },
];

/** High profile may carry 25% more bitrate at the same level than Main. */
const HIGH_PROFILE_BITRATE_FACTOR = 1.25;

/**
 * Lowest level that can legally carry this geometry and bitrate.
 *
 * Verified against reality: libx264 left to itself picks exactly this level for the
 * project's default 1920x1080@30 6000k, and for the integration harness's 320x240@15
 * 400k. That agreement is what makes the computed value safe to serve at cold start.
 */
export function h264LevelFor(
  width: number,
  height: number,
  fps: number,
  bitrateKbps: number,
  profile: H264Profile = "high",
): number {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = macroblocks * fps;
  const factor = profile === "high" ? HIGH_PROFILE_BITRATE_FACTOR : 1;

  const level = LEVELS.find(
    (l) =>
      macroblocks <= l.maxMacroblocks &&
      perSecond <= l.maxMacroblocksPerSecond &&
      bitrateKbps <= l.maxKbps * factor,
  );

  // Nothing in the table fits, which means something far beyond 8K. Advertise the ceiling
  // rather than throwing: a slightly optimistic level is better than no playlist at all.
  return level?.idc ?? 62;
}

/**
 * Normalises a level to the numeric level_idc spelling.
 *
 * This function exists because `-level 4.0` is NOT portable across ffmpeg's H.264
 * encoders, which is a silent-corruption trap rather than an error:
 *
 *   - libx264    `-level` is a string (Annex A); "4", "4.0" and "40" all work.
 *   - h264_nvenc `-level` is an int with named constants; both "4" and "4.0" map to 40.
 *   - h264_vaapi `-level` is an int with named constants, and there is NO "4.0" constant.
 *                "4.0" therefore parses as the integer 4, silently setting level_idc=4.
 *   - h264_qsv   has no private `-level` option at all.
 *
 * The numeric form is the only spelling that is correct everywhere. Do not "simplify"
 * this by passing the dotted string straight through.
 */
export function levelIdcArg(level: string): string {
  const trimmed = level.trim();
  const dotted = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (dotted) return `${dotted[1]}${dotted[2]}`;

  const bare = /^(\d+)$/.exec(trimmed);
  if (!bare) throw new Error(`unrecognised H.264 level: ${level}`);

  // A single digit is a whole level ("4" means 4.0, i.e. level_idc 40); two digits are
  // already a level_idc.
  const value = Number(bare[1]);
  return value < 10 ? String(value * 10) : String(value);
}

/** Turns ffmpeg's `"6000k"` bitrate spelling into kbps. */
export function parseBitrateKbps(bitrate: string): number {
  const parsed = parseInt(bitrate, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return /m$/i.test(bitrate.trim()) ? parsed * 1000 : parsed;
}

/** Derives the codec string from settings alone, for use before any segment exists. */
export function computeCodecs(opts: CodecOptions): CodecString {
  const [profileIdc, constraints] = h264ProfileBytes(opts.profile);
  const levelIdc =
    opts.level === "auto"
      ? h264LevelFor(opts.width, opts.height, opts.fps, opts.bitrateKbps, opts.profile)
      : Number(levelIdcArg(opts.level));

  const video = `avc1.${hex(profileIdc)}${hex(constraints)}${hex(levelIdc)}`;
  return { video, audio: AAC_LC, combined: `${video},${AAC_LC}` };
}

/**
 * Reads the codec string out of a real segment.
 *
 * MPEG-TS carries H.264 as Annex B, which has no `avcC` box to read directly, so the
 * segment is remuxed into a fragmented MP4 on a pipe — one frame, no transcode, no temp
 * file — purely so ffmpeg will build the `avcC` for us. The three bytes after its
 * configurationVersion are exactly profile_idc, constraint flags and level_idc.
 */
export async function measureCodecs(segmentPath: string): Promise<CodecString | null> {
  let buffer: Buffer;
  try {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v", "error",
        "-i", segmentPath,
        "-map", "0:v:0",
        "-c", "copy",
        "-frames:v", "1",
        "-movflags", "frag_keyframe+empty_moov",
        "-f", "mp4",
        "pipe:1",
      ],
      { encoding: "buffer", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    buffer = stdout;
  } catch (err) {
    log.debug(`could not remux ${segmentPath} to read its avcC`, err);
    return null;
  }

  const at = buffer.indexOf("avcC", 0, "ascii");
  // +4 skips the box type, +1 more skips configurationVersion.
  if (at < 0 || at + 8 > buffer.length) {
    log.debug(`no avcC box in the remux of ${segmentPath}`);
    return null;
  }

  const video =
    `avc1.${hex(buffer[at + 5]!)}${hex(buffer[at + 6]!)}${hex(buffer[at + 7]!)}`;
  return { video, audio: AAC_LC, combined: `${video},${AAC_LC}` };
}

export interface ProbedSegment {
  videoCodec: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  frameRate: string | null;
  audioCodec: string | null;
  audioProfile: string | null;
  sampleRate: number | null;
  channels: number | null;
}

/** Human-readable view of a segment, for the debug endpoint to sit next to the raw string. */
export async function probeSegment(segmentPath: string): Promise<ProbedSegment | null> {
  try {
    const { stdout } = await exec(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries",
        "stream=codec_name,codec_type,profile,level,pix_fmt,width,height,r_frame_rate,sample_rate,channels",
        "-of", "json",
        segmentPath,
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout) as {
      streams?: Record<string, unknown>[];
    };
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    const audio = parsed.streams?.find((s) => s.codec_type === "audio");
    if (!video && !audio) return null;

    return {
      videoCodec: str(video?.codec_name),
      profile: str(video?.profile),
      level: num(video?.level),
      width: num(video?.width),
      height: num(video?.height),
      pixFmt: str(video?.pix_fmt),
      frameRate: str(video?.r_frame_rate),
      audioCodec: str(audio?.codec_name),
      audioProfile: str(audio?.profile),
      sampleRate: num(audio?.sample_rate),
      channels: num(audio?.channels),
    };
  } catch (err) {
    log.debug(`probe failed for ${segmentPath}`, err);
    return null;
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
