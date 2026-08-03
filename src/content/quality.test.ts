import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectReleaseLanguage,
  parseRelease,
  parseSize,
  pickBest,
  scoreRelease,
} from "./quality.ts";

const prefs = { qualityPreference: ["1080p", "720p", "2160p", "480p"] };

describe("parseRelease", () => {
  it("reads resolution from a release name", () => {
    assert.equal(parseRelease("Blade.Runner.2049.2017.1080p.BluRay.x264").resolution, 1080);
    assert.equal(parseRelease("Movie.2019.2160p.UHD.BluRay").resolution, 2160);
    assert.equal(parseRelease("Show.S01E01.720p.WEB-DL").resolution, 720);
  });

  it("treats 4k and UHD as 2160p", () => {
    assert.equal(parseRelease("Movie 4K HDR").resolution, 2160);
    assert.equal(parseRelease("Movie UHD BluRay").resolution, 2160);
  });

  it("detects the attributes that affect playability", () => {
    const info = parseRelease("Movie.2160p.UHD.Blu-ray.Remux.HEVC.DV.HDR.TrueHD");
    assert.equal(info.remux, true);
    assert.equal(info.hevc, true);
    assert.equal(info.hdr, true);
  });

  it("flags cam and telesync rips", () => {
    assert.equal(parseRelease("Movie.2024.HDCAM.x264").cam, true);
    assert.equal(parseRelease("Movie.2024.TELESYNC").cam, true);
    assert.equal(parseRelease("Movie.2024.1080p.BluRay").cam, false);
  });

  it("does not mistake substrings for tags", () => {
    // "ts" inside a word must not read as telesync, nor "dv" inside "dvd".
    assert.equal(parseRelease("The.Guests.2020.1080p.BluRay").cam, false);
    assert.equal(parseRelease("Movie.1080p.DVDRip").hdr, false);
  });

  it("recognises common release language tags", () => {
    assert.equal(detectReleaseLanguage("Show.S01E02.1080p.ENG.WEB-DL"), "english");
    assert.equal(detectReleaseLanguage("Movie.2024.MULTI.1080p"), "multi");
    assert.equal(detectReleaseLanguage("Movie.2024.GERMAN.1080p"), "foreign");
    assert.equal(detectReleaseLanguage("Movie.2024.1080p.BluRay"), "unknown");
  });
});

describe("parseSize", () => {
  it("reads Torrentio's size annotation", () => {
    assert.equal(parseSize("Movie 1080p 💾 12.4 GB ⚙️ YTS"), 12_400_000_000);
    assert.equal(parseSize("Show S01E01 💾 800 MB"), 800_000_000);
    assert.equal(parseSize("Pack 💾 1.5 TB"), 1_500_000_000_000);
  });

  it("returns zero when no size is present", () => {
    assert.equal(parseSize("Movie 1080p BluRay"), 0);
  });
});

describe("scoreRelease", () => {
  it("ranks by the configured resolution order, not by raw pixels", () => {
    const p1080 = scoreRelease(parseRelease("Movie.1080p.BluRay"), prefs);
    const p720 = scoreRelease(parseRelease("Movie.720p.BluRay"), prefs);
    const p2160 = scoreRelease(parseRelease("Movie.2160p.BluRay"), prefs);
    assert.ok(p1080 > p720, "1080p should beat 720p");
    assert.ok(p720 > p2160, "720p is listed above 2160p, so it should win");
  });

  it("refuses cam rips outright", () => {
    assert.ok(scoreRelease(parseRelease("Movie.2024.HDCAM"), prefs) < 0);
  });

  it("refuses anything over the size cap", () => {
    const huge = parseRelease("Movie.1080p.BluRay", 80e9);
    assert.ok(scoreRelease(huge, { ...prefs, maxSizeBytes: 25e9 }) < 0);
  });

  it("penalises remuxes, which gain nothing once re-encoded", () => {
    const plain = scoreRelease(parseRelease("Movie.1080p.BluRay"), prefs);
    const remux = scoreRelease(parseRelease("Movie.1080p.BluRay.Remux"), prefs);
    assert.ok(plain > remux);
  });

  it("avoids HEVC only when asked", () => {
    const name = "Movie.1080p.x265";
    assert.ok(
      scoreRelease(parseRelease(name), prefs) >
        scoreRelease(parseRelease(name), { ...prefs, avoidHevc: true }),
    );
  });

  it("uses seeders as a tie-break within a resolution", () => {
    const many = scoreRelease(parseRelease("Movie.1080p.BluRay 👤 150"), prefs);
    const few = scoreRelease(parseRelease("Movie.1080p.BluRay 👤 2"), prefs);
    assert.ok(many > few);
  });

  it("keeps resolution dominant over seeder count", () => {
    const good = scoreRelease(parseRelease("Movie.1080p 👤 1"), prefs);
    const popular = scoreRelease(parseRelease("Movie.480p 👤 200"), prefs);
    assert.ok(good > popular, "a popular 480p must not outrank a 1080p");
  });

  it("prefers English or untagged releases over explicitly foreign-only ones", () => {
    const english = scoreRelease(parseRelease("Movie.720p.ENG"), prefs);
    const unknown = scoreRelease(parseRelease("Movie.720p.BluRay"), prefs);
    const foreign = scoreRelease(parseRelease("Movie.1080p.GERMAN"), prefs);
    assert.ok(english > unknown);
    assert.ok(unknown > foreign, "an untagged fallback should beat a foreign-only tag");
  });
});

describe("pickBest", () => {
  const titles = [
    "Movie.2024.HDCAM.x264 👤 500",
    "Movie.2024.2160p.Remux.HDR 👤 40",
    "Movie.2024.1080p.BluRay.x264 👤 80",
    "Movie.2024.720p.WEB 👤 10",
  ];

  it("chooses the preferred resolution and skips the cam", () => {
    const best = pickBest(titles, (t) => parseRelease(t), prefs);
    assert.equal(best, "Movie.2024.1080p.BluRay.x264 👤 80");
  });

  it("returns null when everything is disqualified", () => {
    const best = pickBest(["Movie.CAM", "Movie.TELESYNC"], (t) => parseRelease(t), prefs);
    assert.equal(best, null);
  });
});
