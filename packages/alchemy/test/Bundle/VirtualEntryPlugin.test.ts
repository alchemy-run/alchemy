import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  isolatedProject,
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../IsolatedProject.ts";

/** Bare (non-relative, non-builtin) `import` statements left in the chunks. */
const bareImports = (result: Bundle.BundleOutput) =>
  result.files
    .filter((file) => typeof file.content === "string")
    .flatMap((file) => (file.content as string).split("\n"))
    .filter((line) => /^import\b/.test(line))
    .filter((line) => !/["'](\.\/|node:)/.test(line));

/** Every generated-entry bootstrap module (see src/Runtime/Bootstrap). */
const BOOTSTRAP_MODULES = [
  "Ecs",
  "AppRunner",
  "Batch",
  "Ec2",
  "Lambda",
  "MicrovmBun",
  "MicrovmNode",
  "CloudflareContainerBun",
  "CloudflareContainerNode",
  "Docker",
  "Fly",
  "Hetzner",
  "Prisma",
] as const;

layer(NodeServices.layer)("generated entry bootstraps", (it) => {
  // The contract every platform's generated entry relies on: a consumer
  // project that has `alchemy` installed and NOTHING else reachable (bun's
  // isolated linker / pnpm) must be able to bundle
  // `alchemy/Runtime/Bootstrap/<Platform>` — i.e. alchemy's own dependencies
  // (`@distilled.cloud/*`, `@effect/platform-*`) resolve from alchemy's
  // location, never from the consumer's. Before the bootstraps became real
  // modules, the entry imported those directly and an isolated project left
  // them external (the deployed process died with `Cannot find module`).
  for (const name of BOOTSTRAP_MODULES) {
    it.effect(
      `alchemy/Runtime/Bootstrap/${name} bundles from an isolated project`,
      () =>
        Effect.gen(function* () {
          const project = isolatedProject(
            `bootstrap-${name.toLowerCase()}`,
            import.meta.filename,
          );
          yield* materializeIsolatedProject(project);
          const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
          // In-repo, every bundler resolves `alchemy/*` through the `bun`
          // export condition (`src/*.ts`) so a test can never exercise a
          // stale `lib/` build — see FunctionBundle.ts. Node-runtime
          // modules still need the `node` condition for their own deps.
          const isNode = name.endsWith("Node") || name === "Lambda";

          try {
            const result = yield* Bundle.build(
              {
                cwd: project.dir,
                input: project.main,
                platform: "node",
                external: ["bun", "bun:*"],
                resolve: {
                  conditionNames: isNode
                    ? ["bun", "node", "import", "module", "default"]
                    : ["bun", "import", "module", "default"],
                },
                plugins: [
                  virtualEntryPlugin(
                    () => `
import * as bootstrap from ${JSON.stringify(`alchemy/Runtime/Bootstrap/${name}`)};
export default bootstrap;
`,
                  ),
                ],
              },
              { format: "esm" },
            );
            expect(bareImports(result)).toEqual([]);
            expect(
              result.files.some(
                (file) =>
                  typeof file.content === "string" &&
                  file.content.includes("bootstrap"),
              ),
            ).toBe(true);
          } finally {
            yield* removeIsolatedProject(project);
          }
        }),
      { timeout: 120_000 },
    );
  }

  // Negative control for the harness itself: without `alchemy` linked the
  // same project resolves nothing, so a green run above is a real signal.
  it.effect("the harness resolves nothing without the alchemy link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = isolatedProject(
        "bootstrap-control",
        import.meta.filename,
      );
      yield* materializeIsolatedProject(project);
      yield* fs.remove(`${project.dir}/node_modules`, { recursive: true });
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      try {
        const result = yield* Bundle.build(
          {
            cwd: project.dir,
            input: project.main,
            platform: "node",
            plugins: [
              virtualEntryPlugin(
                () => `
import * as bootstrap from "alchemy/Runtime/Bootstrap/Ecs";
export default bootstrap;
`,
              ),
            ],
          },
          { format: "esm" },
        );
        expect(bareImports(result)).toEqual([
          'import * as bootstrap from "alchemy/Runtime/Bootstrap/Ecs";',
        ]);
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  );
});
