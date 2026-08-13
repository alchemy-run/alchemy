import { $ } from "bun";

const [tag, channel] = process.argv.slice(2);
if (!tag || !channel)
  throw new Error("Usage: github-release.ts <tag> <channel>");
if ((await $`gh release view ${tag}`.nothrow().quiet()).exitCode === 0)
  process.exit(0);

const stable = channel === "release";
let latest = stable;
let prerelease = !stable;
if (!stable) {
  const releases =
    await $`gh release list --limit 500 --json tagName,isPrerelease`.json();
  const hasStable = releases.some(
    (release: { tagName: string; isPrerelease: boolean }) =>
      /^v?\d+\.\d+\.\d+$/.test(release.tagName) && !release.isPrerelease,
  );
  latest = !hasStable;
  prerelease = hasStable;
}

if (latest) {
  const result = await $`gh release view --latest --json tagName,isPrerelease`
    .nothrow()
    .quiet();
  const current =
    result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : undefined;
  if (
    current &&
    current.tagName !== tag &&
    !/^v?\d+\.\d+\.\d+$/.test(current.tagName) &&
    !current.isPrerelease
  ) {
    await $`gh release edit ${current.tagName} --prerelease=true --latest=false`;
  }
}

const args = [
  "release",
  "create",
  tag,
  "--verify-tag",
  "--generate-notes",
  "--title",
  tag,
  `--latest=${latest}`,
];
if (prerelease) args.push("--prerelease");
await $`gh ${args}`;
