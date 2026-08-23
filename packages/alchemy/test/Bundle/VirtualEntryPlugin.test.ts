import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Top-level `import` statements left in the emitted chunks. */
const externalImports = (result: Bundle.BundleOutput) =>
  result.files
    .filter((file) => typeof file.content === "string")
    .flatMap((file) => (file.content as string).split("\n"))
    .filter((line) => /^import\b/.test(line))
    // Chunk-to-chunk imports are fine; only bare specifiers matter here.
    .filter((line) => !/from\s+["']\.\//.test(line));

layer(NodeServices.layer)("virtualEntryPlugin", (it) => {
  // A generated bootstrap (AWS.ECS.Task, Lambda, Fly, …) is a virtual module
  // with no filesystem location, so rolldown resolves its bare imports from
  // the build cwd — the consumer's project. Alchemy's private SDK
  // dependencies (`@distilled.cloud/*`) only resolve from there when the
  // package manager hoists them; under bun's isolated linker / pnpm they
  // live beside alchemy, rolldown reports [UNRESOLVED_IMPORT] and leaves the
  // import external, and the container crashes at startup with
  // `Cannot find module`.
  it.effect(
    "bundles the bootstrap's imports from a project that cannot resolve them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Empty project: no package.json, no node_modules — nothing bare is
        // resolvable from cwd.
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-virtual-entry-",
        });
        const main = path.join(root, "main.ts");
        yield* fs.writeFileString(
          main,
          `export default "WRAPPED_ENTRY_MARKER";\n`,
        );
        const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

        try {
          const result = yield* Bundle.build(
            {
              cwd: root,
              input: main,
              platform: "node",
              external: ["bun", "bun:*"],
              resolve: {
                conditionNames: ["bun", "import", "module", "default"],
              },
              plugins: [
                virtualEntryPlugin(
                  (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import entrypoint from ${JSON.stringify(importPath)};
export default [BunServices, Stack, Config, Endpoint, entrypoint];
`,
                ),
              ],
            },
            { format: "esm" },
          );

          const imports = externalImports(result);
          expect(
            imports.filter((line) => !/from\s+["']node:/.test(line)),
          ).toEqual([]);
          // The wrapped entry itself was bundled too.
          expect(
            result.files.some(
              (file) =>
                typeof file.content === "string" &&
                file.content.includes("WRAPPED_ENTRY_MARKER"),
            ),
          ).toBe(true);
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
    { timeout: 60_000 },
  );

  // The consumer's own graph still wins for what it can resolve: the wrapped
  // entry's siblings are the first anchor, so a package the project ships
  // locally is the one the bootstrap picks up.
  it.effect("prefers the wrapped entry's package graph", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-virtual-entry-local-",
      });
      // cwd deliberately a sibling temp dir: resolution must anchor on the
      // entry, not walk up from cwd.
      const cwd = yield* fs.makeTempDirectory({
        prefix: "alchemy-virtual-entry-cwd-",
      });
      const pkg = path.join(root, "node_modules", "local-marker");
      yield* fs.makeDirectory(pkg, { recursive: true });
      yield* fs.writeFileString(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "local-marker", main: "index.js" }),
      );
      yield* fs.writeFileString(
        path.join(pkg, "index.js"),
        `export const marker = "LOCAL_MARKER_FROM_PROJECT";\n`,
      );
      const main = path.join(root, "src", "main.ts");
      yield* fs.makeDirectory(path.dirname(main), { recursive: true });
      yield* fs.writeFileString(main, "export default 1;\n");
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      try {
        const result = yield* Bundle.build(
          {
            cwd,
            input: main,
            platform: "node",
            plugins: [
              virtualEntryPlugin(
                (importPath) => `
import { marker } from "local-marker";
import entrypoint from ${JSON.stringify(importPath)};
export default [marker, entrypoint];
`,
              ),
            ],
          },
          { format: "esm" },
        );
        const code = result.files
          .filter((file) => typeof file.content === "string")
          .map((file) => file.content as string)
          .join("\n");
        expect(code).toContain("LOCAL_MARKER_FROM_PROJECT");
        expect(externalImports(result)).toEqual([]);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        yield* fs.remove(cwd, { recursive: true }).pipe(Effect.ignore);
      }
    }),
  );
});
