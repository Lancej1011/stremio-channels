#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), ".github", "workflows");
const failures = [];
for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort()) {
  const lines = readFileSync(join(directory, file), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const use = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line)?.[1];
    // Local actions are part of the checked-out commit and do not have an external ref.
    if (!use || use.startsWith("./")) continue;
    if (!/@[a-f0-9]{40}$/.test(use)) failures.push(`${file}:${index + 1}: ${use}`);
  }
}

if (failures.length > 0) {
  console.error("Workflow actions must be pinned to a full commit SHA:\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Every external workflow action is pinned to a full commit SHA.");
}
