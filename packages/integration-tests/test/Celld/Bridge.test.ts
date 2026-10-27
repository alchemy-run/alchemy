import { describe, expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** Deploy-time modules a fleet Worker bundle must never contain. */
const plannerSources = [
  "alchemy/src/Auth/",
  "alchemy/src/Bundle/",
  "alchemy/src/Local/",
  "alchemy/src/Stack.ts",
  "alchemy/src/Workers/Workerd/Bundle.ts",
  "celld/src/Application.ts",
  "celld/src/Bootstrap.ts",
  "celld/src/Deployment",
  "celld/src/Ecs",
  "celld/src/Management",
  "celld/src/WorkerProvider.ts",
];

const toolchainPackages = [
  "@alchemy.run/aws",
  "@alchemy.run/cloudflare-runtime",
  "@alchemy.run/docker",
  "@distilled.cloud/aws",
  "esbuild",
  "rolldown",
  "vite",
  "workerd",
];

const packageOf = (id: string) => {
  const segments = id.split(/[\\/]node_modules[\\/]/);
  if (segments.length < 2) return undefined;
  const rest = segments[segments.length - 1]!.split(/[\\/]/);
  return rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
};

/** Bundle an entry and collect its reachable modules. */
const bundleEntry = Effect.fn(function* (entry: string) {
  const path = yield* Path.Path;
  const packagesDir = yield* path.fromFileUrl(new URL("../../../", import.meta.url));
  const { rolldown } = yield* Effect.promise(() => import("rolldown"));
  const graph = new Map<string, { isEntry: boolean; importedIds: readonly string[] }>();
  return yield* Effect.acquireUseRelease(
    Effect.promise(() =>
      rolldown({
        input: path.join(packagesDir, entry),
        cwd: packagesDir,
        external: [/^cloudflare:/, /^node:/],
        transform: { define: { "globalThis.__ALCHEMY_RUNTIME__": "true" } },
        plugins: [
          {
            name: "collect-modules",
            moduleParsed(info) {
              graph.set(info.id, {
                isEntry: info.isEntry,
                importedIds: [...info.importedIds, ...info.dynamicallyImportedIds],
              });
            },
          },
        ],
        checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
        logLevel: "silent",
      }),
    ),
    (bundle) =>
      Effect.gen(function* () {
        const { output } = yield* Effect.promise(() => bundle.generate({ format: "esm" }));
        const entry = output.find((item) => item.type === "chunk" && item.isEntry);
        const modules = new Set<string>();
        const queue = [...graph].filter(([, m]) => m.isEntry).map(([id]) => id);
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          if (modules.has(id)) continue;
          modules.add(id);
          queue.push(...(graph.get(id)?.importedIds ?? []));
        }
        // Modules that survive tree-shaking into the output.
        const rendered = output
          .flatMap((item) => (item.type === "chunk" ? Object.entries(item.modules) : []))
          .filter(([, module]) => module.renderedLength > 0)
          .map(([id]) => id)
          .filter((id) => id.startsWith(packagesDir))
          .map((id) => path.relative(packagesDir, id).replaceAll("\\", "/"));
        return {
          rendered,
          exports: entry?.type === "chunk" ? entry.exports : [],
          sources: [...modules]
            .filter((id) => id.startsWith(packagesDir))
            .map((id) => path.relative(packagesDir, id).replaceAll("\\", "/")),
          packages: new Set([...modules].map(packageOf).filter((name) => name !== undefined)),
        };
      }),
    (bundle) => Effect.promise(() => bundle.close()),
  );
});

/** The generated fleet entry's only alchemy import. */
const bundleBridge = bundleEntry("celld/src/Bridge.ts");

describe("@alchemy.run/celld/Bridge", { tags: ["unit", "local", "provider:celld"] }, () => {
  layer(NodeServices.layer)("runtime-only entry", (it) => {
    it.effect(
      "exports the bootstrap the generated fleet entry imports",
      () =>
        Effect.gen(function* () {
          const { exports } = yield* bundleBridge;
          expect(exports).toEqual(
            expect.arrayContaining(["makeFleetBootstrap", "withSqlMigrations"]),
          );
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "keeps deploy-time modules and toolchains out of the fleet Worker bundle",
      () =>
        Effect.gen(function* () {
          const { sources, packages } = yield* bundleBridge;
          expect(sources).toEqual(
            expect.arrayContaining([
              "celld/src/WorkerBridge.ts",
              "celld/src/DurableObjectBridge.ts",
              "alchemy/src/Workers/Workerd/WorkerBridge.ts",
            ]),
          );
          expect(
            sources.filter((source) => plannerSources.some((prefix) => source.startsWith(prefix))),
          ).toEqual([]);
          expect(toolchainPackages.filter((name) => packages.has(name))).toEqual([]);
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "keeps the bundler out of a caller that only binds a Worker",
      () =>
        Effect.gen(function* () {
          const { rendered } = yield* bundleEntry(
            "integration-tests/test/Celld/fixtures/bind-worker-caller.ts",
          );
          expect(rendered).toContain("celld/src/Worker.ts");
          expect(
            rendered.filter(
              (source) =>
                source.startsWith("alchemy/src/Bundle/") ||
                source.startsWith("alchemy/src/Workers/Workerd/Bundle.ts") ||
                source.startsWith("celld/src/WorkerProvider.ts"),
            ),
          ).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });
});
