import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../config.ts";
import type { CodecString } from "./codecs.ts";
import { MEDIA_PLAYLIST_NAME, masterPlaylist, parseMediaPlaylist } from "./playlist.ts";

const CODECS: CodecString = {
  video: "avc1.640028",
  audio: "mp4a.40.2",
  combined: "avc1.640028,mp4a.40.2",
};

/** Only the fields masterPlaylist reads; the rest of Config is irrelevant here. */
const config = {
  video: { width: 1920, height: 1080, fps: 30, bitrate: "6000k", gopSeconds: 2 },
  audio: { bitrate: "128k", sampleRate: 48000, channels: 2 },
} as Config;

/**
 * The real playlist this server serves today, copied verbatim off disk. Using the actual
 * bytes rather than a hand-written approximation is the point: the parser has to cope
 * with what ffmpeg emits, including the short final segment at the live edge.
 */
const REAL_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:46
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:2.000000,
seg000046.ts
#EXTINF:2.000000,
seg000047.ts
#EXTINF:2.000000,
seg000048.ts
#EXTINF:2.000000,
seg000049.ts
#EXTINF:2.000000,
seg000050.ts
#EXTINF:2.000000,
seg000051.ts
#EXTINF:2.000000,
seg000052.ts
#EXTINF:2.000000,
seg000053.ts
#EXTINF:2.000000,
seg000054.ts
#EXTINF:2.000000,
seg000055.ts
#EXTINF:2.000000,
seg000056.ts
#EXTINF:1.400000,
seg000057.ts
`;

describe("masterPlaylist", () => {
  const text = masterPlaylist(CODECS, config);

  it("declares a variant, which is what makes it a master playlist at all", () => {
    // ExoPlayer distinguishes master from media playlists by this tag alone.
    assert.match(text, /^#EXT-X-STREAM-INF:/m);
    assert.match(text, /^#EXTM3U/);
  });

  it("advertises the exact codec string it was given", () => {
    assert.ok(
      text.includes('CODECS="avc1.640028,mp4a.40.2"'),
      `codec attribute missing from:\n${text}`,
    );
  });

  it("points at the media playlist with a relative URI", () => {
    // The whole design rests on this: the master is served at /ch/:id/live.m3u8, so a
    // bare "media.m3u8" resolves to /ch/:id/media.m3u8 and the segments below it resolve
    // to /ch/:id/segNNNNNN.ts, exactly as they do today.
    const lines = text.trimEnd().split("\n");
    assert.equal(lines.at(-1), MEDIA_PLAYLIST_NAME);
    assert.equal(lines.at(-1), "media.m3u8");
  });

  it("describes the raster and frame rate", () => {
    assert.ok(text.includes("RESOLUTION=1920x1080"), text);
    assert.ok(text.includes("FRAME-RATE=30.000"), text);
  });

  it("allows peak bitrate above the average, never below", () => {
    const peak = Number(/BANDWIDTH=(\d+)/.exec(text)![1]);
    const average = Number(/AVERAGE-BANDWIDTH=(\d+)/.exec(text)![1]);
    // Video plus audio, in bits per second.
    assert.equal(average, (6000 + 128) * 1000);
    assert.ok(peak >= average, `peak ${peak} below average ${average}`);
  });

  it("declares no audio rendition, because audio is muxed into the segments", () => {
    // An EXT-X-MEDIA group here would describe a separate audio stream that does not exist.
    assert.ok(!text.includes("EXT-X-MEDIA:"), text);
  });

  it("tracks a changed codec string rather than hardcoding one", () => {
    const main = masterPlaylist(
      { video: "avc1.4d4028", audio: "mp4a.40.2", combined: "avc1.4d4028,mp4a.40.2" },
      config,
    );
    assert.ok(main.includes('CODECS="avc1.4d4028,mp4a.40.2"'), main);
  });
});

describe("parseMediaPlaylist", () => {
  it("reads back what ffmpeg actually wrote", () => {
    const info = parseMediaPlaylist(REAL_PLAYLIST);
    assert.equal(info.version, 6);
    assert.equal(info.targetDuration, 2);
    assert.equal(info.mediaSequence, 46);
    assert.equal(info.segmentCount, 12);
    // Eleven full segments plus the short one at the live edge.
    assert.equal(info.windowSeconds, 23.4);
  });

  it("reports a live playlist as live", () => {
    const info = parseMediaPlaylist(REAL_PLAYLIST);
    // omit_endlist is what keeps the player in live mode across program changes; if this
    // ever becomes true the seek bar unlocks and the channel stops behaving like TV.
    assert.equal(info.hasEndlist, false);
    assert.equal(info.hasProgramDateTime, false);
    assert.equal(info.firstProgramDateTime, null);
  });

  it("spots a discontinuity in the current window", () => {
    const withGap = REAL_PLAYLIST.replace(
      "#EXTINF:2.000000,\nseg000046.ts",
      "#EXT-X-DISCONTINUITY\n#EXTINF:2.000000,\nseg000046.ts",
    );
    assert.equal(parseMediaPlaylist(REAL_PLAYLIST).hasDiscontinuity, false);
    assert.equal(parseMediaPlaylist(withGap).hasDiscontinuity, true);
  });

  it("does not mistake the discontinuity sequence tag for a discontinuity", () => {
    // Every live playlist may carry EXT-X-DISCONTINUITY-SEQUENCE; it is a counter, not a
    // break in the stream, and reporting it as one would send the user hunting a
    // non-existent fault on their TV.
    const withSequence = REAL_PLAYLIST.replace(
      "#EXT-X-MEDIA-SEQUENCE:46",
      "#EXT-X-MEDIA-SEQUENCE:46\n#EXT-X-DISCONTINUITY-SEQUENCE:1",
    );
    const info = parseMediaPlaylist(withSequence);
    assert.equal(info.hasDiscontinuity, false);
    assert.equal(info.discontinuitySequence, 1);
  });

  it("extracts a program date time when one is present", () => {
    const withPdt = REAL_PLAYLIST.replace(
      "#EXTINF:2.000000,\nseg000046.ts",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-02T13:00:00.000+0000\n#EXTINF:2.000000,\nseg000046.ts",
    );
    const info = parseMediaPlaylist(withPdt);
    assert.equal(info.hasProgramDateTime, true);
    assert.equal(info.firstProgramDateTime, "2026-08-02T13:00:00.000+0000");
    assert.ok(Number.isFinite(Date.parse(info.firstProgramDateTime!)));
  });

  it("survives an empty or truncated playlist instead of throwing", () => {
    // The debug endpoint may read the file while ffmpeg is rewriting it.
    const info = parseMediaPlaylist("");
    assert.equal(info.segmentCount, 0);
    assert.equal(info.windowSeconds, 0);
    assert.equal(info.version, null);
    assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-VER").segmentCount, 0);
  });
});
