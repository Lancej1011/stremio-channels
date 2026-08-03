import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { logger } from "../log.ts";
import { levelIdcArg } from "./codecs.ts";

const exec = promisify(execFile);
const log = logger("hwaccel");

export type EncoderKind = "nvenc" | "qsv" | "vaapi" | "cpu";

export interface EncoderProfile {
  kind: EncoderKind;
  /** ffmpeg args that must appear before the input, e.g. VAAPI device init. */
  inputArgs: string[];
  /** Video filter chain, already terminated for this encoder's memory model. */
  filters: string;
  /** Codec selection and rate control. */
  codecArgs: string[];
}

/** Preference order. NVENC first: lowest CPU cost and this is a live, real-time pipeline. */
const ENCODERS: Record<Exclude<EncoderKind, "cpu">, string> = {
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  vaapi: "h264_vaapi",
};

let cached: EncoderKind | undefined;

/**
 * Picks the best available H.264 encoder. This ships to other people's machines,
 * so nothing about the local GPU may be assumed — always probe, always fall back.
 */
export async function detectEncoder(config: Config): Promise<EncoderKind> {
  if (cached) return cached;
  if (config.encoder !== "auto") {
    log.info(`encoder pinned by config: ${config.encoder}`);
    cached = config.encoder;
    return cached;
  }

  let available = "";
  try {
    const { stdout } = await exec("ffmpeg", ["-hide_banner", "-encoders"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    available = stdout;
  } catch (err) {
    log.warn("could not list ffmpeg encoders, falling back to libx264", err);
    cached = "cpu";
    return cached;
  }

  for (const [kind, encoder] of Object.entries(ENCODERS) as [
    Exclude<EncoderKind, "cpu">,
    string,
  ][]) {
    if (!available.includes(encoder)) continue;
    // Listing an encoder does not mean the hardware is usable; a tiny real encode does.
    if (await encodeWorks(encoder, kind)) {
      log.info(`using hardware encoder ${encoder}`);
      cached = kind;
      return cached;
    }
    log.debug(`${encoder} is built in but failed a test encode, skipping`);
  }

  log.info("using software encoder libx264");
  cached = "cpu";
  return cached;
}

/** Encodes a handful of synthetic frames to prove the device actually initialises. */
async function encodeWorks(encoder: string, kind: EncoderKind): Promise<boolean> {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (kind === "vaapi") {
    if (!existsSync("/dev/dri/renderD128")) return false;
    args.push("-vaapi_device", "/dev/dri/renderD128");
  }
  args.push("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=0.2");
  if (kind === "vaapi") args.push("-vf", "format=nv12,hwupload");
  args.push("-c:v", encoder, "-f", "null", "-");

  try {
    await exec("ffmpeg", args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `-level` arguments, or nothing when the level is left to the encoder.
 *
 * `levelIdcArg` converts to the numeric level_idc spelling, which is the only one every
 * encoder reads the same way: h264_vaapi has no "4.0" constant and would silently take it
 * as level 4, and h264_qsv has no `-level` option at all. `auto` — the default — passes
 * nothing, because a pinned level the hardware cannot satisfy makes the encoder refuse to
 * open and takes the whole feed down.
 */
export function levelArgs(config: Config): string[] {
  const { level } = config.video;
  if (!level || level === "auto") return [];
  try {
    return ["-level", levelIdcArg(level)];
  } catch {
    log.warn(`ignoring unrecognised video.level "${level}"; letting the encoder choose`);
    return [];
  }
}

/**
 * Builds the normalization + encode arguments. Every program on a channel must come out
 * of this with byte-identical stream parameters, otherwise the downstream copy-mux
 * produces a stream players reject at the first program change.
 */
export function encoderProfile(kind: EncoderKind, config: Config): EncoderProfile {
  const { width, height, fps, bitrate, gopSeconds, profile } = config.video;
  const level = levelArgs(config);

  // The GOP must be pinned explicitly. Encoders default to their own interval
  // (NVENC uses 250 frames) which overrides -force_key_frames and leaves the HLS
  // muxer unable to cut segments at the requested length.
  const gop = String(Math.round(fps * gopSeconds));

  // B-frames reorder timestamps, and every program boundary here is a seam between
  // two separate encoder processes. Disabling them keeps PTS/DTS trivially monotonic
  // through the handoff, which matters more than the bitrate efficiency it costs.
  const gopArgs = ["-g", gop, "-keyint_min", gop, "-bf", "0", "-sc_threshold", "0"];

  // Letterbox rather than crop or stretch, so a 2.39:1 film and a 4:3 sitcom both
  // land on the exact same raster.
  const base =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
    `setsar=1,fps=${fps}`;

  const bufsize = `${parseInt(bitrate, 10) * 2}k`;

  switch (kind) {
    case "nvenc":
      return {
        kind,
        inputArgs: [],
        filters: `${base},format=yuv420p`,
        codecArgs: [
          "-c:v", "h264_nvenc",
          "-preset", "p4",
          "-profile:v", profile,
          ...level,
          "-rc", "cbr",
          "-b:v", bitrate,
          "-maxrate", bitrate,
          "-bufsize", bufsize,
          // Without this NVENC emits non-IDR frames for forced keyframes, which the
          // HLS muxer cannot cut on.
          "-forced-idr", "1",
          ...gopArgs,
        ],
      };

    case "qsv":
      return {
        kind,
        inputArgs: [],
        filters: `${base},format=nv12`,
        codecArgs: [
          "-c:v", "h264_qsv",
          "-preset", "medium",
          "-profile:v", profile,
          ...level,
          "-b:v", bitrate,
          "-maxrate", bitrate,
          "-bufsize", bufsize,
          ...gopArgs,
        ],
      };

    case "vaapi":
      return {
        kind,
        inputArgs: ["-vaapi_device", "/dev/dri/renderD128"],
        filters: `${base},format=nv12,hwupload`,
        codecArgs: [
          "-c:v", "h264_vaapi",
          "-profile:v", profile,
          ...level,
          "-b:v", bitrate,
          "-maxrate", bitrate,
          "-bufsize", bufsize,
          ...gopArgs,
        ],
      };

    case "cpu":
      return {
        kind,
        inputArgs: [],
        filters: `${base},format=yuv420p`,
        codecArgs: [
          "-c:v", "libx264",
          // veryfast is the slowest preset that reliably keeps up with real time
          // on a modest CPU while transcoding 1080p.
          "-preset", "veryfast",
          "-profile:v", profile,
          ...level,
          "-b:v", bitrate,
          "-maxrate", bitrate,
          "-bufsize", bufsize,
          ...gopArgs,
        ],
      };
  }
}

/** Keyframes must land exactly on segment boundaries or HLS segments drift in length. */
export function keyframeArgs(config: Config): string[] {
  return ["-force_key_frames", `expr:gte(t,n_forced*${config.video.gopSeconds})`];
}

export function audioArgs(config: Config): string[] {
  return [
    "-c:a", "aac",
    "-b:a", config.audio.bitrate,
    "-ar", String(config.audio.sampleRate),
    "-ac", String(config.audio.channels),
  ];
}
