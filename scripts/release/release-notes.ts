#!/usr/bin/env bun
/**
 * Prepend release notes for a tag to CHANGELOG.md. Idempotent: if the tag
 * already appears as a heading in CHANGELOG.md, does nothing.
 *
 * Usage: bun scripts/release/release-notes.ts v2.0.0-beta.13
 */
import { generate } from "changelogithub";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: bun scripts/release/release-notes.ts <tag>");
  process.exit(1);
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const existing = await readFile(changelogPath, "utf-8");
if (existing.includes(`## ${tag}\n`)) {
  console.log(`${tag} already in CHANGELOG.md, skipping`);
  process.exit(0);
}

console.log(`Generating release notes for ${tag}`);
const changelog = await generate({
  to: tag,
  emoji: true,
  contributors: true,
  repo: "alchemy-run/alchemy",
});

await writeFile(
  changelogPath,
  `## ${tag}\n\n${changelog.md}\n\n---\n\n${existing}`,
);
