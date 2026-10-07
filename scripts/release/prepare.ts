import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "../..");
const entries = await readdir(path.join(root, "packages"), {
  withFileTypes: true,
});
const packages = (
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = `packages/${entry.name}`;
        const manifest = JSON.parse(await readFile(path.join(root, dir, "package.json"), "utf8"));
        return manifest.private === true ? undefined : { dir, manifest };
      }),
  )
).filter((pkg) => pkg !== undefined);

async function versions(name: string): Promise<Array<string>> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!response.ok) return [];
  const json = (await response.json()) as {
    versions?: Record<string, unknown>;
  };
  return Object.keys(json.versions ?? {});
}

// Every release is the next `2.0.0-beta.N`. If the previous beta reached npm
// for only some packages, or never got its git tag, it is retried instead.
const maxima = await Promise.all(
  packages.map(async ({ manifest }) =>
    Math.max(
      0,
      ...(await versions(manifest.name)).map((candidate) =>
        Number(candidate.match(/^2\.0\.0-beta\.(\d+)$/)?.[1] ?? 0),
      ),
    ),
  ),
);
const maximum = Math.max(0, ...maxima);
const remoteTag =
  maximum > 0
    ? await $`git ls-remote --exit-code --tags origin ${`refs/tags/v2.0.0-beta.${maximum}`}`
        .nothrow()
        .quiet()
    : undefined;
const complete = maximum > 0 && maxima.every((value) => value === maximum);
const next = complete && remoteTag?.exitCode === 0 ? maximum + 1 : maximum || 1;
const version = `2.0.0-beta.${next}`;

for (const pkg of packages) {
  pkg.manifest.version = version;
  await writeFile(
    path.join(root, pkg.dir, "package.json"),
    `${JSON.stringify(pkg.manifest, null, 2)}\n`,
  );
}
await writeFile(
  path.join(root, "release-packages.json"),
  `${JSON.stringify(
    packages.map(({ dir, manifest }) => ({ dir, name: manifest.name })),
    null,
    2,
  )}\n`,
);

await $`pnpm install --lockfile-only`.cwd(root).quiet();
// stdout is piped into $GITHUB_OUTPUT by the workflow, so keep subcommand
// logs on stderr — only the `version=` line below may reach stdout.
const validation = await $`bun validate:publish-packages`.cwd(root).quiet();
console.error(validation.stdout.toString().trimEnd());

console.log(`version=${version}`);
