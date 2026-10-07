// `package.json` reading shared by the release scripts.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The `package.json` fields the release scripts read. */
export const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
});
export type PackageJson = typeof PackageJson.Type;

/** A whole `package.json`, kept as-is so it can be written back unchanged. */
const RawPackageJson = Schema.Record(Schema.String, Schema.Unknown);

export const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));
const decodeRaw = Schema.decodeUnknownEffect(Schema.fromJsonString(RawPackageJson));

export interface WorkspacePackage {
  /** Directory relative to the workspace root, e.g. `packages/alchemy`. */
  readonly dir: string;
  readonly manifest: PackageJson;
  /** Every field of the manifest, for checks and rewrites. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Non-private packages directly under `directory` (relative to `root`). */
export const publishablePackages = Effect.fn(function* (root: string, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = (yield* fs.readDirectory(path.join(root, directory))).sort();
  const packages = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const manifestPath = path.join(root, directory, entry, "package.json");
      if (!(yield* fs.exists(manifestPath))) return undefined;
      const text = yield* fs.readFileString(manifestPath);
      return {
        dir: path.join(directory, entry),
        manifest: yield* decodePackageJson(text),
        raw: yield* decodeRaw(text),
      } satisfies WorkspacePackage;
    }),
  );
  return packages.filter(
    (pkg): pkg is WorkspacePackage => pkg !== undefined && pkg.manifest.private !== true,
  );
});
