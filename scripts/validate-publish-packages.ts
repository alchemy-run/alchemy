// Checks the publishable workspace packages before a release, and in CI.
//
// - Every publishable alchemy package (`packages/*`) carries the npm metadata
//   a release needs.
// - The alchemy packages share one version, and so do the distilled packages
//   (`submodules/distilled/packages/*`): each group is released in lockstep.
//
// Usage: node scripts/validate-publish-packages.ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

type Manifest = Record<string, unknown>;

const REQUIRED = [
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
] as const;

/** Non-private package manifests directly under `directory`. */
const publishable = Effect.fn(function* (root: string, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(path.join(root, directory));
  const manifests = yield* Effect.forEach(entries.sort(), (entry) => {
    const manifestPath = path.join(root, directory, entry, "package.json");
    return fs
      .exists(manifestPath)
      .pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs
                .readFileString(manifestPath)
                .pipe(
                  Effect.map((text) => ({ dir: entry, manifest: JSON.parse(text) as Manifest })),
                )
            : Effect.succeed(undefined),
        ),
      );
  });
  return manifests.filter(
    (entry) => entry !== undefined && entry.manifest.private !== true,
  ) as Array<{
    dir: string;
    manifest: Manifest;
  }>;
});

const assertMetadata = Effect.fn(function* (
  packages: ReadonlyArray<{ dir: string; manifest: Manifest }>,
) {
  for (const { dir, manifest } of packages) {
    const missing: Array<string> = REQUIRED.filter((field) => manifest[field] == null);
    const publishConfig = manifest.publishConfig as { access?: unknown } | undefined;
    if (publishConfig?.access !== "public") missing.push("publishConfig.access=public");
    if (missing.length > 0) {
      return yield* Effect.fail(
        new Error(`${dir}: missing publish metadata: ${missing.join(", ")}`),
      );
    }
  }
});

const assertOneVersion = Effect.fn(function* (
  group: string,
  packages: ReadonlyArray<{ manifest: Manifest }>,
) {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    return yield* Effect.fail(
      new Error(
        `${group} packages must share one version: ${packages
          .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
          .join(", ")}`,
      ),
    );
  }
  yield* Console.log(`Validated ${packages.length} ${group} packages at ${[...versions][0]}`);
});

const command = Command.make(
  "validate-publish-packages",
  {},
  Effect.fn(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");

    const alchemy = yield* publishable(root, "packages");
    yield* assertMetadata(alchemy);
    yield* assertOneVersion("alchemy", alchemy);
    yield* assertOneVersion("distilled", yield* publishable(root, "submodules/distilled/packages"));
  }),
).pipe(Command.withDescription("Check publish metadata and lockstep versions"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
