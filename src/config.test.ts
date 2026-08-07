import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { channelSchema, loadConfig, sourceSchema } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "chan-config-test-"));
const OWNED_ENV = [
  "VIDEO_PROFILE", "VIDEO_LEVEL",
  "HLS_MASTER_PLAYLIST", "HLS_PROGRAM_DATE_TIME", "HLS_CODECS", "HLS_PLAYLIST_WAIT_SECONDS",
  "ACCESS_TOKEN", "TRUSTED_HOSTS",
  "DEBRID_AGENT_URL", "DEBRID_AGENT_TOKEN", "DEBRID_AGENT_TOKEN_FILE",
  "TORBOX_API_KEY", "TORBOX_API_KEY_FILE",
  "REMOTE_DIRECT_PLAY",
  "PERSIST_RESOLVED_URLS",
  "ALLOW_UNAUTHENTICATED_NON_LOOPBACK",
  "ALLOW_PRIVATE_GUIDE_IMPORTS",
  "ALLOW_IMPORTED_GUIDE_ARTWORK",
  "ALLOW_IMPORTED_GUIDE_SOURCES",
  "AUTH_FAILURE_LIMIT", "AUTH_FAILURE_WINDOW_SECONDS", "AUTH_BLOCK_SECONDS",
  "TUNE_REQUEST_LIMIT_PER_MINUTE",
  "DEBRID_HOURLY_OPERATION_LIMIT", "DEBRID_DAILY_OPERATION_LIMIT",
] as const;

afterEach(() => {
  for (const key of OWNED_ENV) delete process.env[key];
});

/** Writes a config file and loads it, so each case starts from a known file on disk. */
function load(file: Record<string, unknown>): ReturnType<typeof loadConfig> {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(file));
  return loadConfig(path);
}

describe("config defaults", () => {
  it("keeps Phase 3 behaviour on by default but its risky knobs off", () => {
    const config = load({});
    assert.equal(config.hls.masterPlaylist, true);
    assert.equal(config.hls.programDateTime, false);
    assert.equal(config.hls.codecs, undefined);
    assert.equal(config.video.profile, "high");
    // `auto` means "do not pass -level at all". A pinned level a hardware encoder cannot
    // satisfy makes it refuse to open, taking the feed down.
    assert.equal(config.video.level, "auto");
  });

  it("treats empty optional credential placeholders as unset", () => {
    const config = load({
      publicBaseUrl: "",
      streamAddonUrl: "",
      torboxApiKey: "",
      tmdbReadAccessToken: "  ",
      tmdbApiKey: "",
      mdblistApiKey: "",
      traktClientId: "",
      stremioAuthKey: "",
      accessToken: "",
    });
    assert.equal(config.accessToken, undefined);
    assert.equal(config.publicBaseUrl, undefined);
    assert.equal(config.streamAddonUrl, undefined);
    assert.equal(config.torboxApiKey, undefined);
    assert.equal(config.tmdbReadAccessToken, undefined);
    assert.equal(config.tmdbApiKey, undefined);
    assert.equal(config.remoteDirectPlay, false);
    assert.equal(config.persistResolvedUrls, false);
    assert.equal(config.allowUnauthenticatedNonLoopback, false);
    assert.equal(config.allowPrivateGuideImports, false);
    assert.equal(config.allowImportedGuideArtwork, false);
    assert.equal(config.allowImportedGuideSources, false);
    assert.equal(config.authFailureLimit, 20);
    assert.equal(config.authFailureWindowSeconds, 300);
    assert.equal(config.authBlockSeconds, 900);
    assert.equal(config.tuneRequestLimitPerMinute, 30);
    assert.equal(config.debridHourlyOperationLimit, 120);
    assert.equal(config.debridDailyOperationLimit, 1000);
  });

  it("requires both halves of the isolated agent configuration", () => {
    assert.throws(() => load({ debridAgentUrl: "http://127.0.0.1:7665" }), /configured together/);
    assert.throws(() => load({ debridAgentToken: "agent_token_0123456789abcdef" }), /configured together/);
    const config = load({
      debridAgentUrl: "http://127.0.0.1:7665",
      debridAgentToken: "agent_token_0123456789abcdef",
    });
    assert.equal(config.debridAgentUrl, "http://127.0.0.1:7665");
  });
});

describe("access token", () => {
  it("fails closed on an unauthenticated non-loopback bind", () => {
    assert.throws(() => load({ host: "0.0.0.0" }), /refusing an unauthenticated/);
    assert.equal(
      load({ host: "0.0.0.0", allowUnauthenticatedNonLoopback: true }).host,
      "0.0.0.0",
    );
    assert.equal(
      load({ host: "0.0.0.0", accessToken: "viewer_token_0123456789abcdef" }).host,
      "0.0.0.0",
    );
  });
  it("refuses to start on a token that would not survive a URL", () => {
    // Silently ignoring a malformed token would leave a server its operator believes is
    // protected answering to anyone, so this has to be fatal rather than a warning.
    for (const bad of ["short", "has spaces", "has/slash", "träma", "a".repeat(129)]) {
      assert.throws(() => load({ accessToken: bad }), /accessToken/, bad);
    }
  });

  it("accepts a generated base64url secret", () => {
    const token = randomBytes(24).toString("base64url");
    assert.equal(load({ accessToken: token }).accessToken, token);
  });

  it("lets the environment override the file, as every other setting does", () => {
    process.env.ACCESS_TOKEN = "env_token_0123456789abcdef";
    assert.equal(load({ accessToken: "file_token_0123456789abcdef" }).accessToken,
      "env_token_0123456789abcdef");
  });

  it("splits TRUSTED_HOSTS so a container can set it without a config file", () => {
    process.env.TRUSTED_HOSTS = "192.168.1.58:7654, 100.64.0.1:7654";
    assert.deepEqual(load({}).trustedHosts, ["192.168.1.58:7654", "100.64.0.1:7654"]);
  });

  it("defaults to no token and no trusted hosts", () => {
    const config = load({});
    assert.equal(config.accessToken, undefined);
    assert.deepEqual(config.trustedHosts, []);
  });
});

describe("nested environment overrides", () => {
  it("does not discard the rest of the block it overrides", () => {
    // The bug this guards is silent: the top-level merge is a shallow spread, so an env
    // `video` object built naively would replace the file's whole video block and reset
    // bitrate, resolution and frame rate to defaults.
    process.env.VIDEO_PROFILE = "main";
    const config = load({
      video: { bitrate: "9000k", width: 1280, height: 720, fps: 24 },
    });

    assert.equal(config.video.profile, "main", "the override did not apply");
    assert.equal(config.video.bitrate, "9000k", "the env override wiped video.bitrate");
    assert.equal(config.video.width, 1280);
    assert.equal(config.video.height, 720);
    assert.equal(config.video.fps, 24);
  });

  it("keeps the rest of the hls block when one hls variable is set", () => {
    process.env.HLS_MASTER_PLAYLIST = "false";
    const config = load({ hls: { segmentSeconds: 4, listSize: 30 } });

    assert.equal(config.hls.masterPlaylist, false);
    assert.equal(config.hls.segmentSeconds, 4, "the env override wiped hls.segmentSeconds");
    assert.equal(config.hls.listSize, 30);
  });

  it("reads 'false' as false rather than as a truthy string", () => {
    // z.coerce.boolean() would make every non-empty string true, so the documented way to
    // switch the master playlist off would silently switch it on.
    process.env.HLS_MASTER_PLAYLIST = "false";
    assert.equal(load({}).hls.masterPlaylist, false);
    process.env.HLS_MASTER_PLAYLIST = "0";
    assert.equal(load({}).hls.masterPlaylist, false);
    process.env.HLS_MASTER_PLAYLIST = "no";
    assert.equal(load({}).hls.masterPlaylist, false);
  });

  it("reads the affirmative spellings as true", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      process.env.HLS_PROGRAM_DATE_TIME = value;
      assert.equal(load({}).hls.programDateTime, true, `${value} did not read as true`);
    }
  });

  it("coerces the numeric and string knobs", () => {
    process.env.HLS_PLAYLIST_WAIT_SECONDS = "6";
    process.env.HLS_CODECS = "avc1.4d4028,mp4a.40.2";
    process.env.VIDEO_LEVEL = "4.0";
    const config = load({});
    assert.equal(config.hls.playlistWaitSeconds, 6);
    assert.equal(config.hls.codecs, "avc1.4d4028,mp4a.40.2");
    assert.equal(config.video.level, "4.0");
  });

  it("leaves a block untouched when none of its variables are set", () => {
    const config = load({ video: { bitrate: "3000k" }, hls: { listSize: 40 } });
    assert.equal(config.video.bitrate, "3000k");
    assert.equal(config.video.profile, "high");
    assert.equal(config.hls.listSize, 40);
    assert.equal(config.hls.masterPlaylist, true);
  });
});

describe("named channel pools", () => {
  it("rejects non-HTTPS imported artwork capabilities", () => {
    const base = {
      id: "art",
      name: "Art",
      content: [{ type: "movie", id: "tt0000001" }],
    };
    assert.throws(() => channelSchema.parse({ ...base, poster: "http://tracker.example/pixel" }), /https/);
    assert.throws(() => channelSchema.parse({ ...base, poster: "file:///etc/passwd" }), /https/);
    assert.equal(
      channelSchema.parse({ ...base, poster: "https://images.example/poster.jpg" }).poster,
      "https://images.example/poster.jpg",
    );
  });
  it("accepts combined pools and weekday schedule blocks", () => {
    const channel = channelSchema.parse({
      id: "weekend-cartoons",
      name: "Weekend Cartoons",
      pools: [
        { id: "classics", name: "Classics", content: [{ type: "series", id: "tt0115157" }] },
        { id: "action", name: "Action", content: [{ type: "series", id: "tt0278238" }] },
      ],
      defaultPoolIds: ["classics"],
      dayparts: [{
        name: "Saturday action",
        start: "08:00",
        end: "12:00",
        days: ["sat"],
        poolIds: ["classics", "action"],
      }],
    });
    assert.deepEqual(channel.defaultPoolIds, ["classics"]);
    assert.deepEqual(channel.dayparts[0]?.days, ["sat"]);
  });

  it("keeps legacy channels valid without rewriting them into pools", () => {
    const channel = channelSchema.parse({
      id: "legacy",
      name: "Legacy",
      content: [{ type: "movie", id: "tt0000001" }],
    });
    assert.equal(channel.pools.length, 0);
    assert.deepEqual(channel.content, [{ type: "movie", id: "tt0000001" }]);
  });

  it("rejects duplicate, missing, and contradictory pool references", () => {
    const base = {
      id: "bad",
      name: "Bad",
      pools: [
        { id: "same", name: "One", content: [{ type: "movie", id: "tt0000001" }] },
        { id: "same", name: "Two", content: [{ type: "movie", id: "tt0000002" }] },
      ],
      defaultPoolIds: ["missing"],
    };
    assert.throws(() => channelSchema.parse(base), /duplicate pool id|unknown pool/);
    assert.throws(() => channelSchema.parse({
      ...base,
      pools: [{
        id: "same",
        name: "One",
        content: [{ type: "movie", id: "tt0000001" }],
        excluded: [{ type: "movie", id: "tt0000001" }],
      }],
      defaultPoolIds: ["same"],
    }), /pinned and excluded/);
  });

  it("validates the practical TMDB rule ranges", () => {
    const source = sourceSchema.parse({
      kind: "tmdb",
      type: "series",
      includeGenres: [{ id: 16, name: "Animation" }],
      years: [1990, 2005],
      runtime: [20, 35],
      networks: [{ id: 56, name: "Cartoon Network" }],
    });
    assert.equal(source.kind, "tmdb");
    assert.throws(() => sourceSchema.parse({
      kind: "tmdb", type: "movie", years: [2020, 1990], networks: [{ id: 56, name: "Cartoon Network" }],
    }), /year start|networks apply/);
  });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
