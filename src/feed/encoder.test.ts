import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testConfig } from "../testing/harness.ts";
import { programEncoderArgs, type ProgramSource } from "./encoder.ts";
import type { EncoderProfile } from "./hwaccel.ts";

const profile: EncoderProfile = {
  kind: "cpu",
  inputArgs: [],
  filters: "scale=320:240",
  codecArgs: ["-c:v", "libx264"],
};

const source = (audioStreamIndex?: number): ProgramSource => ({
  url: "/tmp/movie.mkv",
  offsetSeconds: 0,
  durationSeconds: 30,
  hasAudio: true,
  audioStreamIndex,
});

function maps(args: string[]): string[] {
  return args.flatMap((arg, index) => arg === "-map" ? [args[index + 1]!] : []);
}

describe("programEncoderArgs audio selection", () => {
  it("maps the English audio index selected by the probe", () => {
    const args = programEncoderArgs(source(2), 0, profile, testConfig("/tmp/encoder-test"));
    assert.deepEqual(maps(args), ["0:v:0", "0:a:2"]);
  });

  it("keeps the first audio track as the safe fallback", () => {
    const args = programEncoderArgs(source(), 0, profile, testConfig("/tmp/encoder-test"));
    assert.deepEqual(maps(args), ["0:v:0", "0:a:0"]);
  });
});
