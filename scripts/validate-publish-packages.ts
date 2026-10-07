// Checks the publishable workspace packages before a release, and in CI.
//
// - Every publishable alchemy package (`packages/*`) carries the npm metadata
//   a release needs.
// - The alchemy packages share one version, and so do the distilled packages
//   (`submodules/distilled/packages/*`): each group is released in lockstep.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

const publishable = async (directory: string) => {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        dir: entry.name,
        manifest: JSON.parse(
          await readFile(path.join(root, directory, entry.name, "package.json"), "utf8"),
        ) as Record<string, unknown>,
      })),
  );
  return manifests.filter(({ manifest }) => manifest.private !== true);
};

const assertOneVersion = (
  group: string,
  packages: Array<{ manifest: Record<string, unknown> }>,
) => {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(
      `${group} packages must share one version: ${packages
        .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
        .join(", ")}`,
    );
  }
  console.log(`Validated ${packages.length} ${group} packages at ${[...versions][0]}`);
};

const alchemy = await publishable("packages");
for (const { dir, manifest } of alchemy) {
  const missing = [
    "name",
    "version",
    "description",
    "homepage",
    "license",
    "author",
    "keywords",
    "repository",
    "bugs",
    "files",
    "exports",
  ].filter((field) => manifest[field] == null);
  const publishConfig = manifest.publishConfig as { access?: unknown } | undefined;
  if (publishConfig?.access !== "public") {
    missing.push("publishConfig.access=public");
  }
  if (missing.length > 0) {
    throw new Error(`${dir}: missing publish metadata: ${missing.join(", ")}`);
  }
}
assertOneVersion("alchemy", alchemy);
assertOneVersion("distilled", await publishable("submodules/distilled/packages"));
