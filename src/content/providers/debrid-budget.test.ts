import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDb } from "../../db.ts";
import { testConfig } from "../../testing/harness.ts";
import { BudgetedTorBoxApi, DebridBudgetExceededError } from "./debrid-budget.ts";
import type { TorBoxApi } from "./torbox.ts";

const root = mkdtempSync(join(tmpdir(), "debrid-budget-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fakeApi(calls: string[]): TorBoxApi {
  return {
    verify: async () => { calls.push("verify"); return true; },
    checkCached: async () => { calls.push("cached"); return new Map(); },
    addMagnet: async () => { calls.push("add"); return 1; },
    torrentFiles: async () => { calls.push("files"); return []; },
    downloadLink: async () => { calls.push("link"); return "https://example.test/file"; },
  };
}

describe("persisted debrid operation budget", () => {
  it("counts upstream-sized operations and refuses work before calling the provider", async () => {
    const dir = join(root, "limits");
    const db = openDb(dir);
    const config = testConfig(dir, {
      debridHourlyOperationLimit: 3,
      debridDailyOperationLimit: 10,
    });
    const calls: string[] = [];
    const api = new BudgetedTorBoxApi(fakeApi(calls), db, config);

    await api.verify(); // Deliberately exempt.
    await api.checkCached(Array.from({ length: 100 }, () => "a".repeat(40))); // Two calls.
    await api.downloadLink(1, 0); // One call.
    await assert.rejects(
      async () => api.addMagnet("a".repeat(40)),
      DebridBudgetExceededError,
    );
    assert.deepEqual(calls, ["verify", "cached", "link"]);
    assert.equal(api.status().hourlyUsed, 3);
    db.close();
  });

  it("survives a database reopen and keeps hourly and daily buckets separate", () => {
    const dir = join(root, "restart");
    const hour = 3_600_000;
    const day = 86_400_000;
    let db = openDb(dir);
    assert.equal(db.consumeDebridUsage(4, 5, 8, day + hour).allowed, true);
    db.close();

    db = openDb(dir);
    assert.equal(db.consumeDebridUsage(2, 5, 8, day + hour).allowed, false);
    assert.equal(db.consumeDebridUsage(2, 5, 8, day + 2 * hour).allowed, true);
    assert.equal(db.consumeDebridUsage(3, 5, 8, day + 2 * hour).allowed, false);
    const status = db.debridUsage(5, 8, day + 2 * hour);
    assert.equal(status.hourlyUsed, 2);
    assert.equal(status.dailyUsed, 6);
    db.close();
  });
});
