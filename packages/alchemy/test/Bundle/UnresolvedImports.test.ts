import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Bundle from "@/Bundle/Bundle";

/**
 * Rolldown leaves an unresolvable import external with only a warning. For
 * an INSTALLED package that cannot be resolved (e.g. an unbuilt workspace
 * package whose `exports` point at a missing `lib/`), that shipped bundles
 * whose deployed runtime died at boot with
 * `Cannot find package '@distilled.cloud/neon'`. The build now fails instead,
 * while a package that is not installed at all stays external as before.
 */
layer(NodeServices.layer)("bundle unresolved imports", (it) => {
  const project = (entrySource: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-unresolved-" });
      // Installed, but its export targets were never built.
      const pkg = path.join(root, "node_modules", "@scope", "unbuilt-pkg");
      yield* fs.makeDirectory(pkg, { recursive: true });
      yield* fs.writeFileString(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "@scope/unbuilt-pkg",
          exports: { ".": { bun: "./src/index.ts", default: "./lib/index.js" } },
        }),
      );
      yield* fs.makeDirectory(path.join(pkg, "src"));
      yield* fs.writeFileString(path.join(pkg, "src", "index.ts"), `export const x = 1;\n`);
      const entry = path.join(root, "entry.mjs");
      yield* fs.writeFileString(entry, entrySource);
      return { root, entry };
    });

  const bundle = (entrySource: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, entry } = yield* project(entrySource);
      return yield* Bundle.build(
        {
          cwd: root,
          input: entry,
          platform: "node",
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
        },
        { format: "esm" },
      ).pipe(
        Effect.result,
        Effect.ensuring(fs.remove(root, { recursive: true }).pipe(Effect.ignore)),
      );
    });

  it.effect(
    "an installed package with missing build output fails the build",
    () =>
      Effect.gen(function* () {
        const result = yield* bundle(`import { x } from "@scope/unbuilt-pkg";\nconsole.log(x);\n`);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(`"@scope/unbuilt-pkg" is installed at`);
        }
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a package that is not installed stays external",
    () =>
      Effect.gen(function* () {
        const result = yield* bundle(`import { y } from "not-installed-pkg";\nconsole.log(y);\n`);
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result)) {
          const code = result.success.files
            .map((file) => (typeof file.content === "string" ? file.content : ""))
            .join("\n");
          expect(code).toContain(`from "not-installed-pkg"`);
        }
      }),
    { tags: ["unit", "local"] },
  );
});
