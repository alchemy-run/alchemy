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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { publishablePackages, type WorkspacePackage } from "./package-manifest.ts";

export class MissingPublishMetadata extends Data.TaggedError("MissingPublishMetadata")<{
  readonly message: string;
  readonly dir: string;
  readonly fields: ReadonlyArray<string>;
}> {}

export class VersionMismatch extends Data.TaggedError("VersionMismatch")<{
  readonly message: string;
  readonly group: string;
  readonly specs: ReadonlyArray<string>;
}> {}

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

const assertMetadata = Effect.fn(function* (packages: ReadonlyArray<WorkspacePackage>) {
  for (const { dir, raw } of packages) {
    const fields: Array<string> = REQUIRED.filter((field) => raw[field] == null);
    const publishConfig = raw.publishConfig as { access?: unknown } | undefined;
    if (publishConfig?.access !== "public") fields.push("publishConfig.access=public");
    if (fields.length > 0) {
      return yield* new MissingPublishMetadata({
        message: `${dir}: missing publish metadata: ${fields.join(", ")}`,
        dir,
        fields,
      });
    }
  }
});

const assertOneVersion = Effect.fn(function* (
  group: string,
  packages: ReadonlyArray<WorkspacePackage>,
) {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    const specs = packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`);
    return yield* new VersionMismatch({
      message: `${group} packages must share one version: ${specs.join(", ")}`,
      group,
      specs,
    });
  }
  yield* Console.log(`Validated ${packages.length} ${group} packages at ${[...versions][0]}`);
});

const command = Command.make(
  "validate-publish-packages",
  {},
  Effect.fn(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");

    const alchemy = yield* publishablePackages(root, "packages");
    yield* assertMetadata(alchemy);
    yield* assertOneVersion("alchemy", alchemy);
    yield* assertOneVersion(
      "distilled",
      yield* publishablePackages(root, "submodules/distilled/packages"),
    );
  }),
).pipe(Command.withDescription("Check publish metadata and lockstep versions"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
