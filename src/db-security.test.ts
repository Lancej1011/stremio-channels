import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openDb } from "./db.ts";

describe("signed URL storage", () => {
  it("scrubs media capabilities without losing refreshable provider identifiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-db-security-"));
    const db = openDb(dir);
    const now = Date.now();
    db.insertPrograms([{
      channel_id: "private",
      slot_index: 1,
      start_ms: now,
      duration_ms: 60_000,
      ref_key: "tt0000001",
      title: "Private",
      resolved_url: "https://signed.example/private-capability",
      url_expires_at: now + 60_000,
      daypart: null,
      torrent_id: 42,
      file_id: 7,
    }]);

    db.scrubResolvedUrls();
    const row = db.programAt("private", now + 1);
    assert.equal(row?.resolved_url, null);
    assert.equal(row?.url_expires_at, null);
    assert.equal(row?.torrent_id, 42);
    assert.equal(row?.file_id, 7);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
