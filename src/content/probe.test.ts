import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredAudioStream, type ProbedStream } from "./probe.ts";

const audio = (
  language?: string,
  disposition: 0 | 1 = 0,
  title?: string,
): ProbedStream => ({
  codec_type: "audio",
  codec_name: "aac",
  tags: { language, title },
  disposition: { default: disposition },
});

describe("preferredAudioStream", () => {
  it("chooses an English track even when a foreign track is first and default", () => {
    const selected = preferredAudioStream([
      { codec_type: "video", codec_name: "h264" },
      audio("jpn", 1),
      audio("eng"),
    ]);
    assert.equal(selected?.index, 1);
    assert.equal(selected?.language, "eng");
  });

  it("recognises English labels when the language tag is absent", () => {
    assert.equal(preferredAudioStream([audio(undefined, 0, "English 5.1")])?.index, 0);
  });

  it("falls back to the container default, then the first track", () => {
    assert.equal(preferredAudioStream([audio("jpn"), audio("spa", 1)])?.index, 1);
    assert.equal(preferredAudioStream([audio("jpn"), audio("spa")])?.index, 0);
  });

  it("returns null for a source with no audio", () => {
    assert.equal(preferredAudioStream([{ codec_type: "video" }]), null);
  });
});
