import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sourceSchema, type SourceDef } from "../../config.ts";
import { openDb } from "../../db.ts";
import { testConfig } from "../../testing/harness.ts";
import { fetchTmdbRule, fetchTmdbSimilar, searchTmdbMetadata, tmdbOptions } from "./tmdb.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("TMDB smart sources", () => {
  it("builds practical discover filters and converts results to cached IMDb ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-source-"));
    const db = openDb(dir);
    const config = testConfig(dir, { tmdbReadAccessToken: "token" });
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input); requested.push(url);
      if (url.includes("/discover/tv")) return json({
        page: 1, total_pages: 1,
        results: [{ id: 10, name: "Space Show", first_air_date: "1998-01-01", vote_average: 8.2, vote_count: 500 }],
      });
      if (url.includes("/tv/10/external_ids")) return json({ imdb_id: "tt1234567" });
      throw new Error(`unexpected ${url}`);
    };
    try {
      const source = tmdbSource({
        kind: "tmdb", type: "series",
        includeGenres: [{ id: 10765, name: "Sci-Fi & Fantasy" }],
        excludeGenres: [{ id: 10764, name: "Reality" }],
        years: [1990, 2000], minRating: 7, minVotes: 100, runtime: [20, 60],
        languages: ["en"], countries: ["US"], networks: [{ id: 49, name: "HBO" }],
        includeKeywords: [{ id: 9882, name: "space" }], sort: "rating", limit: 20,
      });
      const first = await fetchTmdbRule(source, config, db);
      const second = await fetchTmdbRule(source, config, db);
      assert.equal(first[0]?.ref.id, "tt1234567");
      assert.deepEqual(second, first);
      const discover = new URL(requested.find((url) => url.includes("/discover/tv"))!);
      assert.equal(discover.searchParams.get("with_genres"), "10765");
      assert.equal(discover.searchParams.get("without_genres"), "10764");
      assert.equal(discover.searchParams.get("with_networks"), "49");
      assert.equal(discover.searchParams.get("sort_by"), "vote_average.desc");
      assert.equal(requested.filter((url) => url.includes("external_ids")).length, 1, "IMDb mapping was not cached");
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns setup-safe empty options without a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-options-"));
    const db = openDb(dir);
    try {
      const options = await tmdbOptions(testConfig(dir), db);
      assert.equal(options.configured, false);
      assert.ok(options.networks.some((item) => item.name === "Cartoon Network"));
      await assert.rejects(
        fetchTmdbRule(tmdbSource({ kind: "tmdb", type: "movie" }), testConfig(dir), db),
        /tmdbReadAccessToken/,
      );
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a v3 API key without sending a bearer header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-api-key-"));
    const db = openDb(dir);
    const requested: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = async (input, init) => {
      requested.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return json({ genres: [] });
    };
    try {
      await fetchTmdbRule(
        tmdbSource({ kind: "tmdb", type: "movie", limit: 1 }),
        testConfig(dir, { tmdbApiKey: "legacy-key" }),
        db,
      );
      assert.equal(new URL(requested[0]!.url).searchParams.get("api_key"), "legacy-key");
      assert.equal(requested[0]!.authorization, null);
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches common networks without spending a TMDB request", async () => {
    globalThis.fetch = async () => { throw new Error("network search should stay local"); };
    const results = await searchTmdbMetadata("network", "cartoon", testConfig("/tmp"));
    assert.deepEqual(results.map((item) => item.name), ["Cartoon Network"]);
  });

  it("blends movie recommendations before similarity matches and caches the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-similar-movie-"));
    const db = openDb(dir);
    const config = testConfig(dir, { tmdbReadAccessToken: "token" });
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input); requested.push(url);
      if (url.includes("/find/tt0083658")) return json({ movie_results: [{ id: 78, title: "Blade Runner" }] });
      if (url.includes("/movie/78/recommendations")) return json({ results: [
        { id: 101, title: "Recommendation", release_date: "1990-01-01", vote_average: 8, vote_count: 500, poster_path: "/rec.jpg" },
        { id: 102, title: "Both Lists" },
        { id: 78, title: "Seed" },
        { id: 999, title: "Adult", adult: true },
      ] });
      if (url.includes("/movie/78/similar")) return json({ results: [
        { id: 102, title: "Both Lists" },
        { id: 103, title: "No IMDb" },
        { id: 104, title: "Similarity Fill" },
      ] });
      if (url.includes("/movie/101/external_ids")) return json({ imdb_id: "tt1000101" });
      if (url.includes("/movie/102/external_ids")) return json({ imdb_id: "tt1000102" });
      if (url.includes("/movie/103/external_ids")) return json({ imdb_id: null });
      if (url.includes("/movie/104/external_ids")) return json({ imdb_id: "tt1000104" });
      throw new Error(`unexpected ${url}`);
    };
    try {
      const first = await fetchTmdbSimilar("movie", "tt0083658", config, db);
      const callsAfterFirst = requested.length;
      const second = await fetchTmdbSimilar("movie", "tt0083658", config, db);
      assert.deepEqual(second, first, "the final suggestion list was not cached");
      assert.equal(requested.length, callsAfterFirst);
      assert.equal(first.seed.name, "Blade Runner");
      assert.deepEqual(first.titles.map((title) => title.ref.id), ["tt1000101", "tt1000102", "tt1000104"]);
      assert.deepEqual(first.titles[1]?.reasons, ["recommendation", "similar"]);
      assert.deepEqual(first.titles[2]?.reasons, ["similar"]);
      assert.equal(first.titles[0]?.poster, "https://image.tmdb.org/t/p/w342/rec.jpg");
      assert.equal(first.skipped, 1);
      assert.ok(!requested.some((url) => url.includes("/movie/999/")), "adult result was mapped");
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses TV endpoints and keeps similarity results when recommendations fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-similar-tv-"));
    const db = openDb(dir);
    const config = testConfig(dir, { tmdbReadAccessToken: "token" });
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input); requested.push(url);
      if (url.includes("/find/tt0303461")) return json({ tv_results: [{ id: 1437, name: "Firefly" }] });
      if (url.includes("/tv/1437/recommendations")) return json({ error: "temporary" }, 503);
      if (url.includes("/tv/1437/similar")) return json({ results: [{ id: 200, name: "Space Show", first_air_date: "1999-01-01" }] });
      if (url.includes("/tv/200/external_ids")) return json({ imdb_id: "tt2000200" });
      throw new Error(`unexpected ${url}`);
    };
    try {
      const result = await fetchTmdbSimilar("series", "tt0303461", config, db);
      assert.equal(result.titles[0]?.ref.type, "series");
      assert.deepEqual(result.titles[0]?.reasons, ["similar"]);
      assert.ok(requested.some((url) => url.includes("/tv/1437/recommendations")));
      assert.ok(requested.some((url) => url.includes("/tv/1437/similar")));
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps a large suggestion set at thirty IMDb-linked titles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmdb-similar-cap-"));
    const db = openDb(dir);
    const config = testConfig(dir, { tmdbReadAccessToken: "token" });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/find/tt3000000")) return json({ movie_results: [{ id: 300, title: "Seed" }] });
      if (url.includes("/movie/300/recommendations")) return json({ results: Array.from({ length: 35 }, (_, index) => ({ id: 1000 + index, title: `Title ${index}` })) });
      if (url.includes("/movie/300/similar")) return json({ results: [] });
      const match = /\/movie\/(\d+)\/external_ids/.exec(url);
      if (match) return json({ imdb_id: `tt${match[1]!.padStart(7, "0")}` });
      throw new Error(`unexpected ${url}`);
    };
    try {
      const result = await fetchTmdbSimilar("movie", "tt3000000", config, db);
      assert.equal(result.titles.length, 30);
      assert.equal(result.titles[0]?.name, "Title 0");
      assert.equal(result.titles[29]?.name, "Title 29");
    } finally {
      db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function tmdbSource(value: unknown): Extract<SourceDef, { kind: "tmdb" }> {
  return sourceSchema.parse(value) as Extract<SourceDef, { kind: "tmdb" }>;
}
