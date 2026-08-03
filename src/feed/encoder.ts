import type { Config } from "../config.ts";
import { audioArgs, keyframeArgs, type EncoderProfile } from "./hwaccel.ts";

export interface ProgramSource {
  url: string;
  /** Where in the source to begin, in seconds. This is what makes tuning in mid-program work. */
  offsetSeconds: number;
  /** How much to emit before this encoder exits and the next program takes over. */
  durationSeconds: number;
  /** False when the source has no audio track, in which case silence is substituted. */
  hasAudio: boolean;
  /** Preferred zero-based audio-track index. English when the container identifies it. */
  audioStreamIndex?: number;
}

/**
 * Every encoder writes MPEG-TS to stdout with a timeline offset, so that the long-lived
 * packager downstream sees one continuous stream of monotonically increasing timestamps
 * even though a fresh process produced each program.
 */
export function programEncoderArgs(
  source: ProgramSource,
  tsOffsetSeconds: number,
  profile: EncoderProfile,
  config: Config,
): string[] {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...profile.inputArgs,
  ];

  // Reconnect options belong to the HTTP protocol only. Passing them for a local file
  // makes ffmpeg abort with "Option not found" rather than ignoring them.
  if (/^https?:\/\//i.test(source.url)) {
    args.push(
      // Keep retrying rather than dying if the debrid host hiccups mid-program.
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_on_network_error", "1",
      "-reconnect_delay_max", "5",
    );
  }

  // Input-side seek: with a seekable HTTPS source this is a range request, not a decode
  // of everything before the offset, which is what makes mid-program joins instant.
  if (source.offsetSeconds > 0) args.push("-ss", source.offsetSeconds.toFixed(3));

  // Without -re, ffmpeg transcodes as fast as it can download and races ahead of the
  // wall clock, which would desynchronise the channel from its own schedule.
  args.push("-re", "-i", source.url);

  if (!source.hasAudio) {
    args.push(
      "-f", "lavfi",
      "-i", `anullsrc=channel_layout=stereo:sample_rate=${config.audio.sampleRate}`,
    );
  }

  args.push(
    "-t", source.durationSeconds.toFixed(3),
    "-map", "0:v:0",
    "-map", source.hasAudio ? `0:a:${source.audioStreamIndex ?? 0}` : "1:a:0",
    "-sn", "-dn",
    "-vf", profile.filters,
    ...profile.codecArgs,
    ...keyframeArgs(config),
    ...audioArgs(config),
    ...muxArgs(tsOffsetSeconds),
  );

  return args;
}

/**
 * Filler shown when a program cannot be resolved or the next one is not ready yet.
 * The pipe must never starve: a starved packager exits and drops every viewer.
 */
export function slateEncoderArgs(
  text: string,
  durationSeconds: number,
  tsOffsetSeconds: number,
  profile: EncoderProfile,
  config: Config,
  withText: boolean,
): string[] {
  const { width, height, fps } = config.video;

  const filters = withText
    ? `${drawtext(text, config)},${profile.filters}`
    : profile.filters;

  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...profile.inputArgs,
    "-re",
    "-f", "lavfi",
    "-i", `color=c=0x0d1117:s=${width}x${height}:r=${fps}`,
    "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=${config.audio.sampleRate}`,
    "-t", durationSeconds.toFixed(3),
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-vf", filters,
    ...profile.codecArgs,
    ...keyframeArgs(config),
    ...audioArgs(config),
    ...muxArgs(tsOffsetSeconds),
  ];
}

function drawtext(text: string, config: Config): string {
  // Colons and backslashes are filtergraph syntax; single quotes end the value.
  const escaped = text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "")
    .replace(/%/g, "\\%");
  const size = Math.round(config.video.height / 22);
  return (
    `drawtext=font=sans:text='${escaped}':fontcolor=0x8b949e:fontsize=${size}` +
    `:x=(w-text_w)/2:y=(h-text_h)/2`
  );
}

function muxArgs(tsOffsetSeconds: number): string[] {
  return [
    // Zero mux buffering keeps the handoff between programs tight.
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-output_ts_offset", tsOffsetSeconds.toFixed(3),
    "-f", "mpegts",
    "pipe:1",
  ];
}

/**
 * The packager. One per channel, long lived, never restarted while viewers are watching.
 * It only remuxes, so it is cheap; all the real work happens in the encoders upstream.
 * Crucially it never sees an end of stream, so it never writes EXT-X-ENDLIST and the
 * player stays in live mode across program changes.
 */
export function packagerArgs(
  playlistPath: string,
  segmentPattern: string,
  config: Config,
  /**
   * Segment number to resume from. A restarted feed must not renumber from zero: HLS
   * requires EXT-X-MEDIA-SEQUENCE never to decrease across a playlist reload, and a
   * player that reloads after a pause and sees it go backwards treats the stream as
   * reset rather than continuing.
   */
  startNumber = 0,
): string[] {
  const flags = [
    "delete_segments",
    "append_list",
    // Never writing EXT-X-ENDLIST is what keeps the player in live mode across program
    // changes, so this flag is not optional.
    "omit_endlist",
    "independent_segments",
  ];
  // EXT-X-PROGRAM-DATE-TIME gives a player a wall-clock anchor for the live edge. Off by
  // default: it is derived from the timestamps the encoders stamp, and those carry the
  // pipeline's own cursor offset rather than the time of day.
  if (config.hls.programDateTime) flags.push("program_date_time");

  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-fflags", "+genpts",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-c", "copy",
    // Preserve the offsets the encoders stamped, rather than rebasing each time the
    // demuxer notices a new program in the byte stream. The muxer emits one leading
    // EXT-X-DISCONTINUITY either way; it precedes the first segment and is harmless.
    "-copyts",
    "-f", "hls",
    "-hls_time", String(config.hls.segmentSeconds),
    "-hls_list_size", String(config.hls.listSize),
    "-start_number", String(startNumber),
    "-hls_flags", flags.join("+"),
    "-hls_segment_type", "mpegts",
    "-hls_delete_threshold", "3",
    "-hls_segment_filename", segmentPattern,
    playlistPath,
  ];
}
