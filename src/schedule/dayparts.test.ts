import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelSchema, type ChannelDef } from "../config.ts";
import { activeBlock, coversDaypart, coversMinute, mergePools, minutesOfDay, parseTimeOfDay } from "./dayparts.ts";

function channel(overrides: Partial<ChannelDef> = {}): ChannelDef {
  return channelSchema.parse({
    id: "test",
    name: "Test",
    content: [{ type: "movie", id: "tt0001" }],
    ...overrides,
  });
}

const at = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  const d = new Date(2026, 0, 15);
  d.setHours(Number(h), Number(m), 0, 0);
  return d;
};

describe("parseTimeOfDay", () => {
  it("converts clock times to minutes", () => {
    assert.equal(parseTimeOfDay("00:00"), 0);
    assert.equal(parseTimeOfDay("06:30"), 390);
    assert.equal(parseTimeOfDay("23:59"), 1439);
  });
});

describe("coversMinute", () => {
  const morning = { name: "Morning", start: "06:00", end: "12:00" };
  const overnight = { name: "Overnight", start: "23:00", end: "02:00" };

  it("covers a normal daytime range", () => {
    assert.equal(coversMinute(morning, parseTimeOfDay("06:00")), true);
    assert.equal(coversMinute(morning, parseTimeOfDay("09:00")), true);
    assert.equal(coversMinute(morning, parseTimeOfDay("05:59")), false);
    // The end is exclusive, so neighbouring blocks cannot both claim the same minute.
    assert.equal(coversMinute(morning, parseTimeOfDay("12:00")), false);
  });

  it("covers a range that crosses midnight", () => {
    assert.equal(coversMinute(overnight, parseTimeOfDay("23:30")), true);
    assert.equal(coversMinute(overnight, parseTimeOfDay("00:30")), true);
    assert.equal(coversMinute(overnight, parseTimeOfDay("01:59")), true);
    assert.equal(coversMinute(overnight, parseTimeOfDay("02:00")), false);
    assert.equal(coversMinute(overnight, parseTimeOfDay("12:00")), false);
  });

  it("treats an equal start and end as the whole day", () => {
    const allDay = { name: "All", start: "00:00", end: "00:00" };
    assert.equal(coversMinute(allDay, parseTimeOfDay("03:00")), true);
    assert.equal(coversMinute(allDay, parseTimeOfDay("18:00")), true);
  });
});

describe("activeBlock", () => {
  const cartoons = [{ type: "series" as const, id: "tt0115157" }];
  const latenight = [{ type: "series" as const, id: "tt0149460" }];

  const withDayparts = channel({
    strategy: "shuffle",
    content: [{ type: "movie", id: "tt0001" }],
    dayparts: [
      { name: "Morning Cartoons", start: "06:00", end: "12:00", strategy: "sequential", content: cartoons },
      { name: "Late Night", start: "23:00", end: "02:00", content: latenight },
    ],
  });

  it("uses the channel default outside every block", () => {
    const block = activeBlock(withDayparts, at("15:00"));
    assert.equal(block.id, null);
    assert.equal(block.name, null);
    assert.equal(block.strategy, "shuffle");
    assert.deepEqual(block.content, [{ type: "movie", id: "tt0001" }]);
  });

  it("applies a block's content and strategy inside its hours", () => {
    const block = activeBlock(withDayparts, at("08:00"));
    assert.equal(block.name, "Morning Cartoons");
    assert.equal(block.strategy, "sequential");
    assert.deepEqual(block.content, cartoons);
  });

  it("applies a block that crosses midnight on both sides", () => {
    assert.equal(activeBlock(withDayparts, at("23:30")).name, "Late Night");
    assert.equal(activeBlock(withDayparts, at("01:00")).name, "Late Night");
    assert.equal(activeBlock(withDayparts, at("03:00")).name, null);
  });

  it("falls back to the channel strategy when a block only overrides content", () => {
    const block = activeBlock(withDayparts, at("23:30"));
    assert.equal(block.strategy, "shuffle");
  });

  it("keeps channel content when a block only overrides strategy", () => {
    const strategyOnly = channel({
      content: [{ type: "movie", id: "tt0042" }],
      dayparts: [{ name: "Binge", start: "20:00", end: "22:00", strategy: "sequential" }],
    });
    const block = activeBlock(strategyOnly, at("21:00"));
    assert.equal(block.strategy, "sequential");
    assert.deepEqual(block.content, [{ type: "movie", id: "tt0042" }]);
  });

  it("resolves overlaps by list order, so precedence is predictable", () => {
    const overlapping = channel({
      dayparts: [
        { name: "First", start: "10:00", end: "14:00", content: cartoons },
        { name: "Second", start: "12:00", end: "16:00", content: latenight },
      ],
    });
    assert.equal(activeBlock(overlapping, at("13:00")).name, "First");
    assert.equal(activeBlock(overlapping, at("15:00")).name, "Second");
  });

  it("gives each block a distinct counter key even when names collide", () => {
    const sameName = channel({
      dayparts: [
        { name: "Block", start: "06:00", end: "12:00", content: cartoons },
        { name: "Block", start: "18:00", end: "22:00", content: latenight },
      ],
    });
    assert.notEqual(activeBlock(sameName, at("08:00")).id, activeBlock(sameName, at("20:00")).id);
  });
});

describe("minutesOfDay", () => {
  it("reads local wall-clock time", () => {
    assert.equal(minutesOfDay(at("07:45")), 465);
  });
});

describe("weekday blocks and named pools", () => {
  it("anchors an overnight block to the weekday on which it starts", () => {
    const block = {
      name: "Monday late",
      start: "22:00",
      end: "02:00",
      days: ["mon" as const],
    };
    assert.equal(coversDaypart(block, new Date(2026, 7, 3, 23, 0)), true);
    assert.equal(coversDaypart(block, new Date(2026, 7, 4, 1, 0)), true);
    assert.equal(coversDaypart(block, new Date(2026, 7, 4, 23, 0)), false);
  });

  it("combines pools in order and does not duplicate a title", () => {
    const first = { type: "series" as const, id: "tt0000001", weight: 3 };
    const duplicate = { type: "series" as const, id: "tt0000001", weight: 1 };
    const movie = { type: "movie" as const, id: "tt0000002" };
    const pools = new Map([
      ["first", [first]],
      ["second", [duplicate, movie]],
    ]);
    assert.deepEqual(mergePools(["first", "second"], pools), [first, movie]);
  });
});
