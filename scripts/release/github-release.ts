#!/usr/bin/env bun
/**
 * Create a GitHub release for a tag, marked Latest to match npm.
 *
 * `scripts/release/publish.ts` publishes every release, prereleases included,
 * under npm's `latest` dist-tag, so the newest release is GitHub's Latest
 * too. GitHub's API does not allow a release to be both `prerelease=true`
 * and `latest=true`, so a beta/alpha/rc is published with `prerelease=false`
 * (a masquerade). Before publishing, every earlier prerelease-style tag still
 * masquerading is flipped back to `prerelease=true`, so only the newest one
 * looks stable; that also repairs any left over from earlier releases.
 *
 * Channel → flags on the new release:
 *   release|beta|alpha|rc  prerelease=false, latest=true
 *   tag                    prerelease=true,  latest=false
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

function isStableTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

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

const latest = channel !== "tag";

if (latest) {
  const list = await $`gh release list --limit 500 --json tagName,isPrerelease`.quiet();
  const releases = JSON.parse(list.stdout.toString().trim() || "[]") as Array<{
    tagName: string;
    isPrerelease: boolean;
  }>;
  for (const release of releases) {
    if (release.tagName !== tag && !isStableTag(release.tagName) && !release.isPrerelease) {
      console.log(`Demoting masquerading ${release.tagName}: prerelease=false → true`);
      await $`gh release edit ${release.tagName} --prerelease=true --latest=false`;
    }
  }
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

const args = [
  "release",
  "create",
  tag,
  "--title",
  tag,
  "--notes",
  md,
  `--latest=${latest ? "true" : "false"}`,
];
if (!latest) args.push("--prerelease");

await $`gh ${args}`;
