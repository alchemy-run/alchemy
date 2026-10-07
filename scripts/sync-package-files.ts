// Prepares a workspace package for building and publishing.
//
// 1. Generates `publishConfig.exports` from the package's source `exports`.
//    In the workspace, `exports` points straight at `src/*.ts` so every
//    consumer runs from source without a build. Published tarballs swap in
//    `publishConfig.exports`, which resolves to the compiled output and keeps
//    the `bun` (and, where enabled, `worker`) conditions on source.
// 2. Copies the repository's LICENSE, NOTICE and, where needed,
//    THIRD_PARTY_LICENSES.md and README.md into the package.
//
// Usage (from a package's `prebuild`): pnpm -w sync:package-files <package>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

interface PackageOptions {
  /** Generate `publishConfig.exports` from `exports`. */
  readonly exports?: {
    /** Add a `worker` condition on source for Worker bundlers. */
    readonly worker?: boolean;
    /** Subpaths that resolve to source in every condition. */
    readonly sourceOnly?: ReadonlyArray<string>;
  };
  readonly thirdPartyLicenses?: boolean;
  readonly readme?: boolean;
}

const packages = {
  alchemy: {
    // Bootstrap modules are source inputs to the deployment bundler.
    exports: { sourceOnly: ["./Runtime/Bootstrap/*"] },
    thirdPartyLicenses: true,
    readme: true,
  },
  "better-auth": { exports: { worker: true } },
  "cloudflare-runtime": { thirdPartyLicenses: true },
  "cloudflare-test-tools": {},
  floci: { exports: {} },
  "frontend-frameworks": { thirdPartyLicenses: true },
  "node-utils": { exports: {}, thirdPartyLicenses: true },
  pkg: { exports: { worker: true } },
  "vite-plugin-copy-editor": { exports: {} },
} satisfies Record<string, PackageOptions>;

type PackageName = keyof typeof packages;

const syncPublishExports = Effect.fn(function* (
  packageDirectory: string,
  options: NonNullable<PackageOptions["exports"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath)) as {
    exports: Record<string, string | null>;
    publishConfig?: Record<string, unknown>;
  };
  const tsconfig = JSON.parse(
    yield* fs.readFileString(path.join(packageDirectory, "tsconfig.json")),
  ) as { compilerOptions: { outDir: string } };
  const outDir = `./${path.normalize(tsconfig.compilerOptions.outDir)}/`;

  const exports = Object.fromEntries(
    Object.entries(packageJson.exports).map(([subpath, source]) => {
      // Non-source entries (bin scripts, package.json) publish as-is.
      if (source === null || !source.startsWith("./src/")) {
        return [subpath, source];
      }
      if (options.sourceOnly?.includes(subpath)) {
        return [subpath, { types: source, bun: source, default: source }];
      }

      const output = source.replace(/^\.\/src\//, outDir);
      return [
        subpath,
        {
          types: output.replace(/\.tsx?$/, ".d.ts"),
          bun: source,
          ...(options.worker ? { worker: source } : {}),
          default: output.replace(/\.tsx?$/, ".js"),
        },
      ];
    }),
  );

  yield* fs.writeFileString(
    packageJsonPath,
    JSON.stringify(
      { ...packageJson, publishConfig: { ...packageJson.publishConfig, exports } },
      null,
      2,
    ) + "\n",
  );
});

const copyRepositoryFiles = Effect.fn(function* (
  root: string,
  packageDirectory: string,
  options: PackageOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const files = [
    "LICENSE",
    "NOTICE",
    ...(options.thirdPartyLicenses ? ["THIRD_PARTY_LICENSES.md"] : []),
    ...(options.readme ? ["README.md"] : []),
  ];
  yield* Effect.forEach(files, (file) =>
    fs.copyFile(path.join(root, file), path.join(packageDirectory, file)),
  );
});

const command = Command.make(
  "sync-package-files",
  {
    package: Argument.Literals("package", Object.keys(packages) as Array<PackageName>).pipe(
      Argument.withDescription("Directory name of the package under packages/"),
    ),
  },
  Effect.fn(function* ({ package: packageName }) {
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const packageDirectory = path.join(root, "packages", packageName);
    const options: PackageOptions = packages[packageName];

    if (options.exports) {
      yield* syncPublishExports(packageDirectory, options.exports);
    }
    yield* copyRepositoryFiles(root, packageDirectory, options);
  }),
).pipe(
  Command.withDescription(
    "Generate publishConfig.exports and copy license files into a workspace package",
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
