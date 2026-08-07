import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBundle,
  ImportConflictError,
  mergeImported,
  parseBundle,
  SHARE_KIND,
} from "./channels-share.ts";
import { channelSchema, type ChannelDef } from "./config.ts";

function channel(id: string, name = `Channel ${id}`): ChannelDef {
  return channelSchema.parse({
    id,
    name,
    strategy: "shuffle",
    seed: 7,
    content: [{ type: "movie", id: "tt0111161" }],
  });
}

describe("share bundles", () => {
  it("round-trips a lineup", () => {
    const bundle = buildBundle([channel("scifi"), channel("sitcoms")]);
    const parsed = parseBundle(JSON.parse(JSON.stringify(bundle)));
    assert.equal(parsed.kind, SHARE_KIND);
    assert.deepEqual(parsed.channels.map((c) => c.id), ["scifi", "sitcoms"]);
  });

  it("strips anything that is not part of a channel", () => {
    // The guard that matters: a field added to a channel object by some future code path
    // must not ride along into something the operator publishes.
    const dirty = { ...channel("scifi"), torboxApiKey: "secret", _internal: 1 } as ChannelDef;
    const bundle = buildBundle([dirty]);
    const emitted = JSON.stringify(bundle);
    assert.ok(!emitted.includes("torboxApiKey"), "credential-shaped field survived export");
    assert.ok(!emitted.includes("_internal"));
  });

  it("rejects json that is not a guide", () => {
    assert.throws(() => parseBundle({ channels: [] }));
    assert.throws(() => parseBundle({ kind: "something.else", version: 1, channels: [] }));
    assert.throws(() => parseBundle({ kind: SHARE_KIND, version: 99, channels: [] }));
    // An empty guide is a mistake, not an instruction to wipe the lineup.
    assert.throws(() => parseBundle({ kind: SHARE_KIND, version: 1, channels: [] }));
  });

  it("rejects a channel that would not survive validation", () => {
    assert.throws(() =>
      parseBundle({
        kind: SHARE_KIND,
        version: 1,
        channels: [{ id: "Not Valid!", name: "x", content: [{ type: "movie", id: "tt1" }] }],
      })
    );
  });

  it("caps aggregate title references and automatic-source work", () => {
    const refs = Array.from({ length: 2000 }, () => ({ type: "movie", id: "tt0111161" }));
    const oversizedRefs = {
      kind: SHARE_KIND,
      version: 1,
      channels: [{
        id: "large",
        name: "Large",
        pools: Array.from({ length: 6 }, (_, index) => ({
          id: `pool-${index}`,
          name: `Pool ${index}`,
          content: refs,
        })),
        defaultPoolIds: ["pool-0"],
      }],
    };
    assert.throws(() => parseBundle(oversizedRefs), /too many title references/);

    const oversizedSources = {
      kind: SHARE_KIND,
      version: 1,
      channels: [{
        id: "sources",
        name: "Sources",
        pools: Array.from({ length: 11 }, (_, index) => ({
          id: `pool-${index}`,
          name: `Pool ${index}`,
          source: { kind: "rule", type: "movie", limit: 500 },
        })),
        defaultPoolIds: ["pool-0"],
      }],
    };
    assert.throws(() => parseBundle(oversizedSources), /too much source work/);
  });
});

describe("merging an imported guide", () => {
  const mine = [channel("scifi"), channel("sitcoms")];

  it("adds channels that do not collide", () => {
    const result = mergeImported(mine, [channel("cooking")], "add");
    assert.deepEqual(result.added, ["cooking"]);
    assert.deepEqual(result.channels.map((c) => c.id), ["scifi", "sitcoms", "cooking"]);
  });

  it("refuses to clobber on add, naming what collided", () => {
    assert.throws(
      () => mergeImported(mine, [channel("scifi"), channel("cooking")], "add"),
      (err: unknown) => {
        assert.ok(err instanceof ImportConflictError);
        assert.deepEqual(err.ids, ["scifi"]);
        return true;
      },
    );
  });

  it("replaces in place, keeping list order", () => {
    const result = mergeImported(mine, [channel("scifi", "Theirs")], "replace");
    assert.deepEqual(result.replaced, ["scifi"]);
    assert.deepEqual(result.channels.map((c) => c.id), ["scifi", "sitcoms"]);
    assert.equal(result.channels[0]?.name, "Theirs");
  });

  it("renames collisions so both survive", () => {
    const result = mergeImported(mine, [channel("scifi", "Theirs")], "rename");
    assert.deepEqual(result.renamed, [{ from: "scifi", to: "scifi-2" }]);
    assert.deepEqual(result.channels.map((c) => c.id), ["scifi", "sitcoms", "scifi-2"]);
    // The original is untouched; the newcomer is the one that moved.
    assert.equal(result.channels[0]?.name, "Channel scifi");
    assert.equal(result.channels[2]?.name, "Theirs");
  });

  it("does not pile up suffixes when the same pack is imported twice", () => {
    const once = mergeImported(mine, [channel("scifi")], "rename");
    const twice = mergeImported(once.channels, [channel("scifi")], "rename");
    assert.deepEqual(twice.renamed, [{ from: "scifi", to: "scifi-3" }]);
    assert.ok(!twice.channels.some((c) => c.id.includes("-2-")));
  });

  it("leaves the caller's list untouched", () => {
    const before = mine.map((c) => c.id);
    mergeImported(mine, [channel("cooking")], "add");
    assert.deepEqual(mine.map((c) => c.id), before);
  });
});
