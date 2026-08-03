import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContentRef } from "../../config.ts";
import { parseRelease } from "../quality.ts";
import {
  chooseFile,
  matchingAccountFile,
  type TorBoxFileInfo,
} from "./torbox-resolver.ts";
import type { Candidate } from "./indexer.ts";

const candidate = (fileIdx?: number): Candidate => ({
  hash: "abc",
  title: "Some Release",
  release: parseRelease("Some.Release.1080p"),
  fileIdx,
});

const file = (id: number, name: string, size = 1e9): TorBoxFileInfo => ({ id, name, size });

const episode = (season: number, ep: number): ContentRef => ({
  type: "series",
  id: "tt0001",
  season,
  episode: ep,
});

const movie: ContentRef = { type: "movie", id: "tt0002" };

describe("chooseFile for episodes", () => {
  const pack = [
    file(0, "Show.S01E01.1080p.mkv"),
    file(1, "Show.S01E02.1080p.mkv"),
    file(2, "Show.S01E03.1080p.mkv"),
  ];

  it("picks the requested episode out of a season pack", () => {
    assert.equal(chooseFile(pack, candidate(), episode(1, 2))?.id, 1);
  });

  it("matches common naming variants", () => {
    assert.equal(chooseFile([file(0, "Show 1x04 720p.mkv")], candidate(), episode(1, 4))?.id, 0);
    assert.equal(chooseFile([file(0, "Show - E07 - Title.mkv")], candidate(), episode(1, 7))?.id, 0);
    assert.equal(chooseFile([file(0, "Show.s02.e11.mkv")], candidate(), episode(2, 11))?.id, 0);
  });

  it("rejects a pack that does not contain the episode", () => {
    // This is the point of returning null: the caller can try the next candidate
    // instead of airing whatever file happened to be largest.
    assert.equal(chooseFile(pack, candidate(), episode(1, 9)), null);
    assert.equal(chooseFile(pack, candidate(), episode(4, 1)), null);
  });

  it("does not confuse episode 1 with episode 10", () => {
    const files = [file(0, "Show.S01E10.mkv"), file(1, "Show.S01E01.mkv")];
    assert.equal(chooseFile(files, candidate(), episode(1, 1))?.id, 1);
    assert.equal(chooseFile(files, candidate(), episode(1, 10))?.id, 0);
  });

  it("accepts a single-file torrent even when the name omits the episode", () => {
    // The indexer already matched this torrent to the episode; a lone video file in it
    // is that episode, however it happens to be named.
    const lone = [file(0, "some.scene.release.name.mkv")];
    assert.equal(chooseFile(lone, candidate(), episode(3, 5))?.id, 0);
  });

  it("ignores samples and extras", () => {
    const withJunk = [
      file(0, "sample-Show.S01E02.mkv", 5e6),
      file(1, "Show.S01E02.1080p.mkv", 2e9),
    ];
    assert.equal(chooseFile(withJunk, candidate(), episode(1, 2))?.id, 1);
  });

  it("ignores non-video files entirely", () => {
    const files = [file(0, "Show.S01E02.nfo"), file(1, "Show.S01E02.srt")];
    assert.equal(chooseFile(files, candidate(), episode(1, 2)), null);
  });
});

describe("chooseFile for movies", () => {
  it("takes the largest video file", () => {
    const files = [file(0, "featurette.mkv", 3e8), file(1, "Movie.1080p.mkv", 8e9)];
    assert.equal(chooseFile(files, candidate(), movie)?.id, 1);
  });

  it("prefers the index the indexer pointed at", () => {
    const files = [file(0, "Movie.Theatrical.mkv", 5e9), file(1, "Movie.Extended.mkv", 9e9)];
    assert.equal(chooseFile(files, candidate(0), movie)?.id, 0);
  });

  it("falls back to size when that index is not present", () => {
    const files = [file(0, "Movie.mkv", 5e9), file(1, "Movie.Extended.mkv", 9e9)];
    assert.equal(chooseFile(files, candidate(42), movie)?.id, 1);
  });

  it("returns null when a torrent has no video at all", () => {
    assert.equal(chooseFile([file(0, "readme.txt")], candidate(), movie), null);
    assert.equal(chooseFile([], candidate(), movie), null);
  });

  it("falls back to junk-named files rather than airing nothing", () => {
    // If every video looks like an extra, one of them is still better than a dead slot.
    const onlyJunk = [file(0, "trailer.mkv", 1e8)];
    assert.equal(chooseFile(onlyJunk, candidate(), movie)?.id, 0);
  });
});

describe("matchingAccountFile", () => {
  it("uses the account file id even when the cache-check id differs", () => {
    const cached = file(0, "Show/Show.S01E02.1080p.mkv", 2e9);
    const account = [file(17, "Show.S01E02.1080p.mkv", 2e9)];
    assert.equal(matchingAccountFile(account, cached)?.id, 17);
  });

  it("uses size to disambiguate duplicate basenames", () => {
    const cached = file(0, "disc-b/Movie.mkv", 8e9);
    const account = [file(4, "disc-a/Movie.mkv", 4e9), file(9, "disc-b/Movie.mkv", 8e9)];
    assert.equal(matchingAccountFile(account, cached)?.id, 9);
  });

  it("does not guess when no account filename matches", () => {
    assert.equal(matchingAccountFile([file(3, "Other.mkv")], file(0, "Movie.mkv")), null);
  });
});
