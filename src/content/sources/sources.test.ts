import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceSchema } from "../../config.ts";
import { parseListUrl } from "./imports.ts";
import { matchesRule, parseYear } from "./rule.ts";

const rule = (over: Record<string, unknown> = {}) =>
  sourceSchema.parse({ kind: "rule", type: "movie", ...over }) as Extract<
    ReturnType<typeof sourceSchema.parse>,
    { kind: "rule" }
  >;

describe("parseYear", () => {
  it("reads a plain year", () => {
    assert.equal(parseYear("1994"), 1994);
    assert.equal(parseYear(1994), 1994);
  });

  it("takes the first year from a range", () => {
    // Series carry "1994–2004"; the start is the one that places them in an era.
    assert.equal(parseYear("1994–2004"), 1994);
    assert.equal(parseYear("1999-"), 1999);
  });

  it("returns null when there is no year", () => {
    assert.equal(parseYear(undefined), null);
    assert.equal(parseYear(""), null);
    assert.equal(parseYear("unknown"), null);
  });
});

describe("matchesRule", () => {
  it("requires an IMDb id", () => {
    assert.equal(matchesRule({ id: "kitsu:123", releaseInfo: "1990" }, rule()), false);
    assert.equal(matchesRule({ releaseInfo: "1990" }, rule()), false);
  });

  it("accepts anything when no filters are set", () => {
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "2020" }, rule()), true);
  });

  it("applies an inclusive year range", () => {
    const r = rule({ years: [1975, 1999] });
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1975" }, r), true);
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1999" }, r), true);
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1974" }, r), false);
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "2000" }, r), false);
  });

  it("excludes titles with no year when a year rule is set", () => {
    // Including them would quietly widen the range the user asked for.
    assert.equal(matchesRule({ id: "tt1" }, rule({ years: [1975, 1999] })), false);
    assert.equal(matchesRule({ id: "tt1" }, rule()), true);
  });

  it("applies a minimum rating", () => {
    const r = rule({ minRating: 7 });
    assert.equal(matchesRule({ id: "tt1", imdbRating: "7.0" }, r), true);
    assert.equal(matchesRule({ id: "tt1", imdbRating: 8.2 }, r), true);
    assert.equal(matchesRule({ id: "tt1", imdbRating: "6.9" }, r), false);
  });

  it("excludes unrated titles when a rating rule is set", () => {
    const r = rule({ minRating: 7 });
    assert.equal(matchesRule({ id: "tt1" }, r), false);
    assert.equal(matchesRule({ id: "tt1", imdbRating: "N/A" }, r), false);
  });

  it("applies year and rating together", () => {
    const r = rule({ years: [1980, 1989], minRating: 7.5 });
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1985", imdbRating: "8.0" }, r), true);
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1985", imdbRating: "7.0" }, r), false);
    assert.equal(matchesRule({ id: "tt1", releaseInfo: "1995", imdbRating: "8.0" }, r), false);
  });
});

describe("parseListUrl", () => {
  it("reads a full MDBList url", () => {
    assert.deepEqual(parseListUrl("https://mdblist.com/lists/garycrawfordgc/latest-tv-shows"), {
      user: "garycrawfordgc",
      list: "latest-tv-shows",
    });
  });

  it("reads a Trakt list url", () => {
    assert.deepEqual(parseListUrl("https://trakt.tv/users/someone/lists/best-of-1985"), {
      user: "someone",
      list: "best-of-1985",
    });
  });

  it("accepts a bare user/list pair", () => {
    assert.deepEqual(parseListUrl("someone/my-list"), { user: "someone", list: "my-list" });
  });

  it("tolerates trailing slashes and query strings", () => {
    assert.deepEqual(parseListUrl("https://mdblist.com/lists/bob/horror/"), {
      user: "bob",
      list: "horror",
    });
    assert.deepEqual(parseListUrl("https://trakt.tv/users/bob/lists/horror?sort=rank"), {
      user: "bob",
      list: "horror",
    });
  });

  it("returns null for something unusable", () => {
    assert.equal(parseListUrl("https://example.com"), null);
    assert.equal(parseListUrl(""), null);
  });
});

describe("source schema", () => {
  it("defaults a rule sensibly", () => {
    const parsed = sourceSchema.parse({ kind: "rule" });
    assert.equal(parsed.kind, "rule");
    if (parsed.kind === "rule") {
      assert.equal(parsed.type, "movie");
      assert.equal(parsed.limit, 50);
      assert.deepEqual(parsed.genres, []);
    }
  });

  it("rejects an unknown kind", () => {
    assert.throws(() => sourceSchema.parse({ kind: "imdb", url: "x" }));
  });

  it("rejects a rating outside 0-10", () => {
    assert.throws(() => sourceSchema.parse({ kind: "rule", minRating: 11 }));
  });
});
