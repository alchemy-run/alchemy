/**
 * Environment plumbing for effectful Astro sites (Serve/DESIGN.md — the
 * mount design): EXPLICIT MOUNTS ONLY. The user's fetch file
 * (`src/fetch.ts` by default) IS the fetchable — their mount composes
 * `site.fetch(request) ?? astro(new FetchState(request))` and astro's own
 * fetchable plugin resolves the file directly, prod and dev, on every
 * adapter. Nothing is generated, nothing is sniffed, and no routes are
 * baked anywhere.
 *
 * What remains here supports that mount:
 *
 * - a config plugin that stamps `globalThis.__ALCHEMY_RUNTIME__` into the
 *   server environments (folds plan-only `host.bind` guards at build
 *   time) and excludes the alchemy graph from the dep optimizer (the
 *   mount's imports are discovered lazily otherwise, and a mid-request
 *   re-optimize breaks the workerd module runner), plus the workerd node
 *   stubs on Cloudflare;
 * - a prerender passthrough that keeps the build-time prerender worker on
 *   astro's default pipeline, so the mount's alchemy graph never
 *   evaluates there.
 */
import type * as vite from "vite";

const FETCHABLE_MODULE_ID = "virtual:astro:fetchable";

/**
 * An inert stub module: every named export is a callable Proxy that allows
 * arbitrary property chains without evaluating anything, and throws only
 * when actually invoked. The stubbed packages are engine/dev-host
 * machinery reachable from the resource modules' import graphs (local
 * providers, workerd host, platform proxies) that must never *run* inside
 * a worker — but whose module-scope evaluation would drag megabytes of
 * host tooling (or crash outright) in the dev module runner.
 */
const inertStub = (names: ReadonlyArray<string>): string =>
  [
    `const inert = new Proxy(function inert() {}, {`,
    `  get: (_t, prop) => (prop === Symbol.toPrimitive ? () => "" : inert),`,
    `  apply: () => {`,
    `    throw new Error(`,
    `      "@alchemy.run/cloudflare-runtime is host-side machinery and is " +`,
    `        "not available inside the worker (alchemy dev stub)",`,
    `    );`,
    `  },`,
    `});`,
    `export default inert;`,
    ...names.map((name) => `export const ${name} = inert;`),
  ].join("\n");

const NODE_STUBS: Record<string, string> = {
  // `workerd` runs binary-path resolution at module scope. cloudflare-runtime
  // only reads the binary path + metadata, never inside a worker.
  workerd: [
    `export default "";`,
    `export const compatibilityDate = "";`,
    `export const version = "";`,
  ].join("\n"),
  // The workerd host runtime + binding simulators + platform proxy: value
  // imports reach the worker graph through alchemy's resource modules
  // (Cloudflare/LocalRuntime.ts, Local gateways, RuntimeBindings) but are
  // only ever *called* by local providers in the engine/sidecar process.
  // The `core` graph also inlines prebuilt internal workers (multi-MB
  // modules) that OOM workerd's module runner if evaluated.
  "@alchemy.run/cloudflare-runtime/core": inertStub([
    "layerRuntime",
    "Runtime",
  ]),
  "@alchemy.run/cloudflare-runtime/core/bindings": inertStub([
    "Ai",
    "AiSearch",
    "AnalyticsEngine",
    "Artifacts",
    "Assets",
    "Browser",
    "D1",
    "Data",
    "DispatchNamespace",
    "DurableObjectNamespace",
    "Flagship",
    "Hyperdrive",
    "Images",
    "Json",
    "KvNamespace",
    "MtlsCertificate",
    "Pipelines",
    "Queue",
    "R2Bucket",
    "RateLimit",
    "SecretKey",
    "SecretsStore",
    "SendEmail",
    "Service",
    "Stream",
    "Text",
    "Vectorize",
    "VersionMetadata",
    "VpcService",
    "WasmModule",
    "WorkerLoader",
    "Workflows",
  ]),
  "@alchemy.run/cloudflare-runtime/core/bindings/d1/D1Options": inertStub([
    "SERVICE_D1",
  ]),
  "@alchemy.run/cloudflare-runtime/core/platform-proxy": inertStub(["open"]),
  // Reached from alchemy's vite-source module (engine machinery riding the
  // Website arm's import graph); only ever CALLED host-side.
  "@alchemy.run/cloudflare-runtime/core/internal/Port": inertStub([
    "viteSupportsPortZero",
  ]),
};
const STUB_PREFIX = "\0virtual:alchemy:astro-node-stub:";

/**
 * Alias entries for the stubs, longest key first so an exact subpath key
 * wins over the `core` prefix (rollup alias string semantics: a string
 * `find` matches the exact specifier or a `find + "/"` prefix, appending
 * the remainder to the replacement — which lands on the right stub key
 * either way).
 */
const STUB_ALIASES = Object.keys(NODE_STUBS)
  .sort((a, b) => b.length - a.length)
  .map((find) => ({ find, replacement: `${STUB_PREFIX}${find}` }));

/**
 * The alchemy runtime graph the generated wrapper drags into the server
 * environments. The fetchable is a virtual module, so vite's dep scanner
 * finds none of it up front — `effect` (and the rest) would be "discovered"
 * lazily on the first request, triggering a mid-request re-optimize whose
 * stale-hash window breaks the workerd module runner ("file does not exist
 * ... in the optimize deps directory"). Exclude the graph so the module
 * runner transforms it as source; results are cached per module after the
 * first load.
 */
const OPTIMIZE_EXCLUDES = [
  "effect",
  "alchemy",
  "@effect/platform-node",
  "@effect/platform-bun",
  "@alchemy.run/cloudflare-runtime",
  "@distilled.cloud/aws",
  "@distilled.cloud/cloudflare",
  "@distilled.cloud/core",
  ...Object.keys(NODE_STUBS),
];

export interface EffectFetchablePluginOptions {
  /**
   * Where the mount runs, which decides the config shape:
   *
   * - `"cloudflare"`: the server environments execute in workerd — the
   *   workerd node stubs alias in, and the plugin applies to the `ssr`
   *   environment only.
   * - `"node"` (the AWS Lambda / Node target): applies to the `ssr` and
   *   `astro` (dev) environments.
   *
   * @default "node"
   */
  readonly platform?: "cloudflare" | "node" | undefined;
}

export const createEffectFetchablePlugin = (
  options: EffectFetchablePluginOptions,
): vite.Plugin[] => {
  const platform = options.platform ?? "node";
  const environments = platform === "cloudflare" ? ["ssr"] : ["ssr", "astro"];
  // Config-time hooks live on their own GLOBAL plugin (no
  // `applyToEnvironment`, no `enforce`): environment instances don't exist
  // at config-resolution time, so an environment-scoped plugin's
  // `config`/`configEnvironment` hooks are not reliably invoked.
  const configPlugin: vite.Plugin = {
    name: "@alchemy.run/frontend-frameworks/astro:effect-config",
    ...(platform === "cloudflare"
      ? {
          config() {
            return {
              resolve: {
                // Top-level so every environment (and the dep optimizer)
                // sees it; no client module imports these packages, so the
                // reach is safe.
                alias: STUB_ALIASES,
              },
            };
          },
        }
      : {}),
    configEnvironment(name) {
      if (environments.includes(name)) {
        return {
          // Folds plan-only `host.bind` guards at build time (prod); the
          // wrapper also stamps the flag at module evaluation, so
          // correctness holds in dev where the define can't fold.
          define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
          optimizeDeps: { exclude: [...OPTIMIZE_EXCLUDES] },
        };
      }
    },
    // The node stubs must resolve in EVERY environment (the alias above is
    // config-wide), so their resolution lives on the global plugin too.
    resolveId: {
      filter: { id: new RegExp(`^${STUB_PREFIX.replace("\0", "\\0")}`) },
      handler(id) {
        return id;
      },
    },
    load: {
      filter: { id: new RegExp(`^${STUB_PREFIX.replace("\0", "\\0")}`) },
      handler(id) {
        // Unknown subpaths under a stubbed prefix get a bare inert stub
        // (leniently satisfied by the module runner's namespace access).
        return {
          code: NODE_STUBS[id.slice(STUB_PREFIX.length)] ?? inertStub([]),
        };
      },
    },
  };
  // PRERENDER exclusion for user mounts: astro core resolves `fetchFile`
  // (the user's src/fetch.ts) in EVERY environment, but the mount's
  // alchemy graph must never evaluate in the build-time prerender worker
  // (module-eval alone can crash it — CJS interop, engine chains). The
  // prerender fetchable is replaced with a passthrough that runs astro's
  // own pipeline verbatim, mirroring the exclusion the generated wrapper
  // always had.
  const PRERENDER_PASSTHROUGH_ID =
    "\0virtual:alchemy:astro-prerender-fetchable";
  const prerenderPlugin: vite.Plugin = {
    name: "@alchemy.run/frontend-frameworks/astro:effect-prerender-fetchable",
    enforce: "pre",
    applyToEnvironment(environment) {
      return environment.name === "prerender";
    },
    resolveId: {
      filter: {
        id: new RegExp(
          `^(?:${FETCHABLE_MODULE_ID}|${PRERENDER_PASSTHROUGH_ID.replace("\0", "\\0")})$`,
        ),
      },
      handler() {
        return PRERENDER_PASSTHROUGH_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(`^${PRERENDER_PASSTHROUGH_ID.replace("\0", "\\0")}$`),
      },
      handler() {
        return [
          `import { FetchState, astro } from "astro/fetch";`,
          `export default {`,
          `  fetch: (request) => astro(new FetchState(request)),`,
          `};`,
        ].join("\n");
      },
    },
  };
  return [configPlugin, prerenderPlugin];
};
