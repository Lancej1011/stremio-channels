#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const installed = JSON.parse(execFileSync("npm", ["query", "*"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}));
const productionTree = JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}));

const production = new Set();
walk(productionTree.dependencies);
const rows = installed
  .filter((entry) => production.has(`${entry.name}@${entry.version}`))
  .map((entry) => ({
    name: String(entry.name ?? "unknown"),
    version: String(entry.version ?? "unknown"),
    license: licenseName(entry.license),
    repository: repositoryUrl(entry.repository),
  }))
  .filter((entry, index, all) =>
    all.findIndex((other) => other.name === entry.name && other.version === entry.version) === index)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const unknown = rows.filter((entry) => entry.license === "UNKNOWN");
if (process.argv.includes("--check")) {
  if (unknown.length > 0) {
    console.error(`Dependencies with unknown licenses: ${unknown.map((entry) => entry.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified license metadata for ${rows.length} production dependency installations.`);
  }
} else {
  console.log("# Third-party production dependencies\n");
  console.log("Generated from the installed production dependency graph. Verify this report for each release.\n");
  console.log("| Package | Version | License | Repository |");
  console.log("| --- | --- | --- | --- |");
  for (const entry of rows) {
    const name = escapeCell(entry.name);
    const repository = entry.repository ? `[source](${entry.repository})` : "—";
    console.log(`| ${name} | ${escapeCell(entry.version)} | ${escapeCell(entry.license)} | ${repository} |`);
  }
  if (unknown.length > 0) process.exitCode = 1;
}

function licenseName(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value.type === "string") return value.type;
  return "UNKNOWN";
}

function walk(dependencies) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    production.add(`${name}@${dependency.version}`);
    walk(dependency.dependencies);
  }
}

function repositoryUrl(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? `https://github.com/${cleaned}` : cleaned;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
