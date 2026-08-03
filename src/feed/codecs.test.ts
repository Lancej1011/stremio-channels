import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AAC_LC,
  computeCodecs,
  h264LevelFor,
  h264ProfileBytes,
  levelIdcArg,
  parseBitrateKbps,
  type CodecOptions,
} from "./codecs.ts";

/** The project's own output settings, and the integration harness's. */
const PRODUCTION: CodecOptions = {
  width: 1920, height: 1080, fps: 30, bitrateKbps: 6000, profile: "high", level: "auto",
};
const HARNESS: CodecOptions = {
  width: 320, height: 240, fps: 15, bitrateKbps: 400, profile: "high", level: "auto",
};

describe("h264LevelFor", () => {
  it("picks the level libx264 picks for this project's real output", () => {
    // Measured, not guessed: ffprobe on a live segment reports level 40, and reading the
    // avcC box of a remuxed frame gives 0x28. If this assertion ever fails, the computed
    // cold-start codec string has started lying about the stream.
    assert.equal(h264LevelFor(1920, 1080, 30, 6000, "high"), 40);
  });

  it("picks the level libx264 picks for the integration harness geometry", () => {
    assert.equal(h264LevelFor(320, 240, 15, 400, "high"), 12);
  });

  it("moves up a level when the frame rate doubles", () => {
    // 1080p60 exceeds level 4.0's macroblock rate, so it must reach 4.2.
    assert.equal(h264LevelFor(1920, 1080, 60, 6000, "high"), 42);
  });

  it("handles the common intermediate and large geometries", () => {
    assert.equal(h264LevelFor(1280, 720, 30, 4000, "high"), 31);
    assert.equal(h264LevelFor(3840, 2160, 30, 20000, "high"), 51);
  });

  it("is driven by bitrate as well as geometry", () => {
    // Same frame size and rate; only the bitrate pushes this past level 4.0's ceiling,
    // which for High profile is 20000 x 1.25 = 25000 kbps.
    assert.equal(h264LevelFor(1920, 1080, 30, 20000, "high"), 40);
    assert.equal(h264LevelFor(1920, 1080, 30, 30000, "high"), 41);
  });

  it("allows High profile more bitrate than Main at the same level", () => {
    // Main's ceiling at level 4.0 is 20000 kbps; High's is 25% higher.
    assert.equal(h264LevelFor(1920, 1080, 30, 24000, "high"), 40);
    assert.equal(h264LevelFor(1920, 1080, 30, 24000, "main"), 41);
  });

  it("rounds partial macroblocks up rather than down", () => {
    // 724 is 45.25 macroblock rows. Rounded up it is 46, giving 3680 macroblocks, which
    // is past level 3.1's 3600 ceiling and so needs 3.2. Rounded down it would be exactly
    // 3600 and appear to fit — a level too low for the stream actually being sent.
    assert.equal(h264LevelFor(1280, 724, 30, 4000, "high"), 32);
    assert.equal(h264LevelFor(1280, 720, 30, 4000, "high"), 31);
  });
});

describe("h264ProfileBytes", () => {
  it("sets the constraint byte Main is conventionally advertised with", () => {
    // This is the byte most likely to be wrong. Encoders set constraint_set1_flag when
    // promising Main compatibility, so the string is 4d40 and not 4d00 — get this wrong
    // and ExoPlayer rejects a stream it could actually have played.
    assert.deepEqual(h264ProfileBytes("main"), [0x4d, 0x40]);
    assert.deepEqual(h264ProfileBytes("high"), [0x64, 0x00]);
  });
});

describe("levelIdcArg", () => {
  it("normalises every spelling to the numeric level_idc", () => {
    // The only portable spelling. `-level 4.0` silently sets level_idc=4 on h264_vaapi,
    // which has no "4.0" named constant, and h264_qsv has no -level option at all.
    // Do not simplify this away by passing the dotted form straight to ffmpeg.
    assert.equal(levelIdcArg("4.0"), "40");
    assert.equal(levelIdcArg("4"), "40");
    assert.equal(levelIdcArg("40"), "40");
    assert.equal(levelIdcArg("4.1"), "41");
    assert.equal(levelIdcArg("3.1"), "31");
    assert.equal(levelIdcArg("5.2"), "52");
  });

  it("tolerates surrounding whitespace from a hand-edited config", () => {
    assert.equal(levelIdcArg(" 4.0 "), "40");
  });

  it("rejects nonsense rather than passing it to ffmpeg", () => {
    assert.throws(() => levelIdcArg("high"), /unrecognised H.264 level/);
    assert.throws(() => levelIdcArg(""), /unrecognised H.264 level/);
  });
});

describe("parseBitrateKbps", () => {
  it("reads ffmpeg's bitrate spellings", () => {
    assert.equal(parseBitrateKbps("6000k"), 6000);
    assert.equal(parseBitrateKbps("128k"), 128);
    assert.equal(parseBitrateKbps("6M"), 6000);
    assert.equal(parseBitrateKbps("400"), 400);
  });

  it("returns zero for junk instead of NaN, which would poison the playlist", () => {
    assert.equal(parseBitrateKbps("abc"), 0);
  });
});

describe("computeCodecs", () => {
  it("produces the string measured from this project's real output", () => {
    assert.equal(computeCodecs(PRODUCTION).video, "avc1.640028");
    assert.equal(computeCodecs(PRODUCTION).combined, "avc1.640028,mp4a.40.2");
  });

  it("produces the string the integration harness should measure", () => {
    assert.equal(computeCodecs(HARNESS).video, "avc1.64000c");
  });

  it("flips the profile and constraint bytes together for Main", () => {
    assert.equal(computeCodecs({ ...PRODUCTION, profile: "main" }).video, "avc1.4d4028");
  });

  it("honours a pinned level instead of deriving one", () => {
    assert.equal(computeCodecs({ ...PRODUCTION, level: "3.1" }).video, "avc1.64001f");
    assert.equal(computeCodecs({ ...PRODUCTION, level: "41" }).video, "avc1.640029");
  });

  it("always advertises AAC-LC, which is all ffmpeg's native encoder emits", () => {
    assert.equal(computeCodecs(PRODUCTION).audio, AAC_LC);
    assert.equal(computeCodecs(HARNESS).audio, "mp4a.40.2");
  });
});
