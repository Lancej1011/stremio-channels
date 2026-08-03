import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogItemName } from "./manifest.ts";

describe("catalogItemName", () => {
  it("shows the channel and current series without episode details", () => {
    assert.equal(
      catalogItemName("90s Sitcoms", "Seinfeld - S06E08 - The Mom & Pop Store"),
      "90s Sitcoms • Seinfeld",
    );
  });

  it("supports episode numbers wider than two digits", () => {
    assert.equal(
      catalogItemName("Cartoon Cartoons", "Adventure Time - S10E112 - Finale"),
      "Cartoon Cartoons • Adventure Time",
    );
  });

  it("preserves punctuation and hyphens in a series name", () => {
    assert.equal(
      catalogItemName("Sci-Fi", "Star Trek: Deep Space Nine - S01E01 - Emissary"),
      "Sci-Fi • Star Trek: Deep Space Nine",
    );
  });

  it("keeps a complete movie title", () => {
    assert.equal(
      catalogItemName("Late Night Sci-Fi", "Blade Runner 2049"),
      "Late Night Sci-Fi • Blade Runner 2049",
    );
  });

  it("uses only the channel name when nothing is scheduled", () => {
    assert.equal(catalogItemName("Late Night Sci-Fi"), "Late Night Sci-Fi");
    assert.equal(catalogItemName("Late Night Sci-Fi", "  "), "Late Night Sci-Fi");
  });
});
