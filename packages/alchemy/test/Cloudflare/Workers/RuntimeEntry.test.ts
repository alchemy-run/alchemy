import * as Cloudflare from "@/Cloudflare";
import * as Bridge from "@/Cloudflare/Bridge";
import { describe, expect, it } from "alchemy-test";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

/**
 * A Worker entry imports its bridge factories at runtime. Importing them
 * from the `alchemy/Cloudflare` namespace drags the namespace's planner
 * tooling (the rolldown and Vite source providers, the local Worker
 * runtime, the container bundler, and through them esbuild, rolldown,
 * vite and workerd) into the Worker's module graph. A production bundle
 * tree-shakes those modules away; a dev server that evaluates the module
 * graph does not, and dies on their top-level `require.resolve` calls.
 *
 * `alchemy/Cloudflare/Bridge` is the runtime-only entry. This suite bundles
 * it exactly the way a Worker is bundled (workerd resolve conditions,
 * `nodejs_compat`) and asserts that its module graph stays free of that
 * tooling while still exporting everything the generated entry needs.
 */

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Source modules that only run on the planner side (never in workerd). */
const plannerSources = [
  "src/Bundle/",
  "src/Cloudflare/Containers/ContainerBundle.ts",
  "src/Cloudflare/Website/Vite.ts",
  "src/Cloudflare/Workers/LocalWorkerProvider.ts",
  "src/Cloudflare/Workers/Sources/",
  "src/Cloudflare/Workers/ViteChild",
  "src/Cloudflare/Workers/WorkerProvider.ts",
];

/** Toolchain packages that must never be part of a Worker's module graph. */
const toolchainPackages = ["esbuild", "rolldown", "vite", "workerd"];

const packageOf = (id: string) => {
  const segments = id.split(/[\\/]node_modules[\\/]/);
  if (segments.length < 2) return undefined;
  const rest = segments[segments.length - 1]!.split(/[\\/]/);
  return rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
};

/**
 * Bundle `entry` the way `WorkerBundle` bundles a Worker and report the
 * modules its static import graph reaches (what a dev server evaluates:
 * before tree-shaking, and without following dynamic imports) alongside
 * the emitted code.
 */
const bundleWorkerEntry = async (entry: string) => {
  // Loaded lazily, like Workers/Sources/Rolldown.ts does: importing the
  // plugin at module scope loses the test collector's async context.
  const { default: cloudflare } =
    await import("@alchemy.run/cloudflare-runtime/rolldown");
  const graph = new Map<
    string,
    { isEntry: boolean; importedIds: readonly string[] }
  >();
  const bundle = await rolldown({
    input: nodePath.join(packageRoot, entry),
    cwd: packageRoot,
    // See Workers/Sources/Rolldown.ts: guarded native requires that trip
    // rolldown's resolver before dead-code elimination can prune them.
    external: ["lightningcss", "fsevents"],
    plugins: [
      cloudflare({
        compatibilityDate: "2025-04-01",
        compatibilityFlags: ["nodejs_compat"],
      }),
      {
        name: "collect-modules",
        moduleParsed(info) {
          graph.set(info.id, {
            isEntry: info.isEntry,
            importedIds: info.importedIds,
          });
        },
      },
    ],
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
    logLevel: "silent",
  });
  const { output } = await bundle.generate({ format: "esm" });
  const chunks = new Map(
    output
      .filter((item) => item.type === "chunk")
      .map((chunk) => [chunk.fileName, chunk] as const),
  );
  const entryChunk = [...chunks.values()].find((chunk) => chunk.isEntry)!;
  const exports = entryChunk.exports;
  // The code a dev server evaluates: the entry chunk and the chunks it
  // imports statically (not the ones behind dynamic imports).
  const staticChunks = new Set<string>();
  const chunkQueue = [entryChunk.fileName];
  for (let f = chunkQueue.shift(); f !== undefined; f = chunkQueue.shift()) {
    // `imports` also lists externals (`node:events`, `cloudflare:workers`).
    if (staticChunks.has(f) || !chunks.has(f)) continue;
    staticChunks.add(f);
    chunkQueue.push(...chunks.get(f)!.imports);
  }
  const code = [...staticChunks].map((f) => chunks.get(f)!.code).join("\n");
  const modules = new Set<string>();
  const queue = [...graph].filter(([, m]) => m.isEntry).map(([id]) => id);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (modules.has(id)) continue;
    modules.add(id);
    queue.push(...(graph.get(id)?.importedIds ?? []));
  }
  const sources = [...modules]
    .filter((id) => id.startsWith(nodePath.join(packageRoot, "src")))
    .map((id) => nodePath.relative(packageRoot, id).replaceAll("\\", "/"));
  const packages = new Set(
    [...modules].map(packageOf).filter((name) => name !== undefined),
  );
  return { code, exports, sources, packages };
};

const isPlannerSource = (source: string) =>
  plannerSources.some((prefix) => source.startsWith(prefix));

describe("alchemy/Cloudflare/Bridge (runtime-only entry)", () => {
  it("exports the bridge factories the generated Worker entry imports", async () => {
    const { exports } = await bundleWorkerEntry("src/Cloudflare/Bridge.ts");
    expect(exports).toEqual(
      expect.arrayContaining([
        "makeWorkerBridge",
        "makeDurableObjectBridge",
        "makeWorkflowBridge",
        // The framework-worker helpers the entry always carried.
        "fromCloudflareFetcher",
        "toRpcAsync",
      ]),
    );
  });

  it("keeps planner tooling out of a Worker's module graph", async () => {
    const { code, sources, packages } = await bundleWorkerEntry(
      "src/Cloudflare/Bridge.ts",
    );
    expect(sources.filter(isPlannerSource)).toEqual([]);
    expect(toolchainPackages.filter((name) => packages.has(name))).toEqual([]);
    expect(code).not.toContain("require.resolve");
  });

  // The control: the same detector sees the tooling the namespace pulls
  // (the local Worker provider loads the `workerd` package, whose loader
  // calls `require.resolve` at module scope), which is why the generated
  // entry no longer imports from the namespace.
  it("the alchemy/Cloudflare namespace does pull that tooling", async () => {
    const { code, sources, packages } = await bundleWorkerEntry(
      "src/Cloudflare/index.ts",
    );
    expect(sources).toContain("src/Cloudflare/Workers/Sources/Rolldown.ts");
    expect(packages.has("workerd")).toBe(true);
    expect(code).toContain("require.resolve");
  });

  it("alchemy/Cloudflare still re-exports the same factories", () => {
    expect(Cloudflare.makeWorkerBridge).toBe(Bridge.makeWorkerBridge);
    expect(Cloudflare.makeDurableObjectBridge).toBe(
      Bridge.makeDurableObjectBridge,
    );
    expect(Cloudflare.makeWorkflowBridge).toBe(Bridge.makeWorkflowBridge);
  });
});
