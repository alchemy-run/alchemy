#!/usr/bin/env bun
/**
 * Create a GitHub release for a tag, marked Latest to match npm.
 *
 * `scripts/release/publish.ts` publishes every release, prereleases included,
 * under npm's `latest` dist-tag, so every release is a plain (non-prerelease)
 * GitHub release and the newest one is Latest; GitHub cannot mark a
 * prerelease Latest. release.yml does not run this for tag releases.
 *
 * Usage: bun github-release.ts <tag> <release|beta|alpha|rc|tag>
 *
 * Reads ALCHEMY_REPO for the GitHub repo to query commit history from.
 */
import { $ } from "bun";
import { generate } from "./changelog.ts";
import { repo } from "./config.ts";

type Channel = "release" | "beta" | "alpha" | "rc" | "tag";
const CHANNELS: readonly Channel[] = ["release", "beta", "alpha", "rc", "tag"];

const tag = process.argv[2];
const channel = process.argv[3] as Channel | undefined;
if (!tag || !channel || !CHANNELS.includes(channel)) {
  console.error("Usage: bun github-release.ts <tag> <release|beta|alpha|rc|tag>");
  process.exit(1);
}

const view = await $`gh release view ${tag}`.nothrow().quiet();
if (view.exitCode === 0) {
  console.log(`Release ${tag} already exists on GitHub, skipping`);
  process.exit(0);
}

const prev = await $`git describe --tags --abbrev=0 ${`${tag}^`}`.nothrow().quiet();
const from = prev.exitCode === 0 ? prev.stdout.toString().trim() : undefined;

console.log(`Generating release notes for ${tag}${from ? ` from ${from}` : ""}`);
const { md } = await generate({
  from,
  to: tag,
  emoji: true,
  contributors: true,
  repo: repo(),
});

const args = ["release", "create", tag, "--title", tag, "--notes", md, "--latest"];

await $`gh ${args}`;
