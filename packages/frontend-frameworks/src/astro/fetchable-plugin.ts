/**
 * The effectful-Website delivery seam for Astro (DESIGN §6.2c): an
 * `enforce: "pre"` vite plugin that pre-resolves Astro 7's
 * `virtual:astro:fetchable` (the `fetchFile` advanced-routing seam — astro
 * core delegates every `App.render` through it, prod and dev, on every
 * adapter) to a generated wrapper module:
 *
 * ```js
 * import { FetchState, astro } from "astro/fetch";
 * import { toFetchable } from "alchemy/serve/astro";
 * import Site from "/abs/path/to/site.ts";
 * const site = toFetchable(Site, { routes: ["/api/*"] });
 * export default {
 *   async fetch(request) {
 *     return (await site.fetch(request)) ?? astro(new FetchState(request));
 *   },
 * };
 * ```
 *
 * Effect handlers first (routes-scoped, passthrough on `RouteNotFound`),
 * Astro's whole pipeline as the fallback. When the user authored their own
 * fetch file (`src/fetch.ts` by default):
 *
 * - if it already mounts `alchemy/serve` (the explicit tier), the plugin
 *   **stands down** — astro's own fetchable plugin resolves the user file
 *   directly and no double bridging occurs;
 * - otherwise the user fetchable is composed as the fallback in place of
 *   `astro(state)` (the user file keeps full control of the astro
 *   pipeline).
 *
 * The plugin applies to the `ssr` (prod + dev-in-workerd) and `astro`
 * (dev) environments only — deliberately NOT to `prerender`: the
 * build-time prerender worker keeps astro's default fetchable, so the
 * effect module graph never loads there and prerendering is a guaranteed
 * no-op for the effect tier (belt and braces on top of the bridge's
 * env-marker guard, which declines requests in any world without
 * `ALCHEMY_STACK_NAME`).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";

const FETCHABLE_MODULE_ID = "virtual:astro:fetchable";
const RESOLVED_WRAPPER_ID = "\0virtual:alchemy:astro-fetchable";

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
  "@distilled.cloud/cloudflare",
  "@distilled.cloud/core",
  ...Object.keys(NODE_STUBS),
];

/**
 * Marks a user fetch file that already mounts the alchemy runtime bridge
 * (the explicit tier): the serve sentinel literal, or an `alchemy/serve`
 * import specifier. Either one makes the wrapper generator stand down.
 */
const mountsServe = (source: string): boolean =>
  source.includes("__ALCHEMY_SERVE_v1__") || /["']alchemy\/serve/.test(source);

export interface EffectFetchablePluginOptions {
  /**
   * The user's effect-program module (`props.main`) — an absolute path or
   * `file://` URL. The generated wrapper re-imports its default export
   * (the Website class) inside the framework's server graph.
   */
  readonly mainPath: string;
  /** Path globs the effect fetch owns (the construct's `server.routes`). */
  readonly routes: ReadonlyArray<string>;
  /** Resolved `config.srcDir` (URL or path). */
  readonly srcDir: URL | string;
  /**
   * Resolved `config.fetchFile` (`"fetch"` default; `null` = the user
   * disabled the fetch-file seam, so there is never a user fetchable).
   */
  readonly fetchFile: string | null | undefined;
  /**
   * Where the wrapper runs, which decides how the alchemy env is sourced:
   *
   * - `"cloudflare"` (the CF integration): the `ssr` environment always
   *   executes in workerd (prod and dev), so the wrapper statically
   *   imports `env` from `cloudflare:workers` (externalized by the
   *   adapter) and hands it to the bridge — no reliance on the guarded
   *   dynamic-import ladder inside the vite module runner. Applies to the
   *   `ssr` environment only.
   * - `"node"` (a Node/Lambda target): no `cloudflare:workers` import —
   *   the bridge's env ladder resolves `process.env`. Applies to the
   *   `ssr` and `astro` (dev) environments.
   *
   * @default "node"
   */
  readonly platform?: "cloudflare" | "node" | undefined;
}

/** Normalize a path or `file://` URL to a `/`-separated absolute path. */
const toPath = (value: URL | string): string =>
  (typeof value === "string"
    ? value.startsWith("file:")
      ? fileURLToPath(value)
      : value
    : fileURLToPath(value)
  ).replaceAll("\\", "/");

export const createEffectFetchablePlugin = (
  options: EffectFetchablePluginOptions,
): vite.Plugin[] => {
  const mainPath = toPath(options.mainPath);
  const srcDir = toPath(options.srcDir).replace(/\/?$/, "/");
  const fetchFileDisabled = options.fetchFile === null;
  const fetchFile = options.fetchFile ?? "fetch";
  const platform = options.platform ?? "node";
  /** The user fetch file composed as the fallback (`undefined` = astro pipeline). */
  let userFetchId: string | undefined;
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
  const fetchablePlugin: vite.Plugin = {
    name: "@alchemy.run/frontend-frameworks/astro:effect-fetchable",
    enforce: "pre",
    applyToEnvironment(environment) {
      return environments.includes(environment.name);
    },
    resolveId: {
      filter: {
        id: new RegExp(`^${FETCHABLE_MODULE_ID}$`),
      },
      async handler() {
        userFetchId = undefined;
        if (!fetchFileDisabled) {
          const resolved = await this.resolve(`${srcDir}${fetchFile}`);
          if (resolved) {
            const source = await readFile(
              resolved.id.split("?")[0]!,
              "utf-8",
            ).catch(() => undefined);
            if (source !== undefined && mountsServe(source)) {
              // Explicit mount wins — let astro's own fetchable plugin
              // resolve the user file directly (no double bridging).
              return null;
            }
            userFetchId = resolved.id;
          }
        }
        return RESOLVED_WRAPPER_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(`^${RESOLVED_WRAPPER_ID.replace("\0", "\\0")}$`),
      },
      handler() {
        const fallback =
          userFetchId !== undefined
            ? {
                imports: `import userFetchable from ${JSON.stringify(userFetchId)};`,
                call: "userFetchable.fetch(request)",
              }
            : {
                imports: `import { FetchState, astro } from "astro/fetch";`,
                call: "astro(new FetchState(request))",
              };
        // On Cloudflare the `ssr` environment always executes in workerd
        // (prod and dev-in-module-runner alike), so the wrapper hands the
        // importable workerd env to the bridge directly instead of relying
        // on the guarded dynamic-import ladder.
        const env =
          platform === "cloudflare"
            ? {
                imports: `import { env as __alchemyWorkerEnv } from "cloudflare:workers";`,
                option: ", env: __alchemyWorkerEnv",
              }
            : { imports: "", option: "" };
        return {
          code: [
            `globalThis.__ALCHEMY_RUNTIME__ = true;`,
            `import { toFetchable } from "alchemy/serve/astro";`,
            ...(env.imports === "" ? [] : [env.imports]),
            fallback.imports,
            `import Site from ${JSON.stringify(mainPath)};`,
            `const site = toFetchable(Site, { routes: ${JSON.stringify(options.routes)}${env.option} });`,
            `export default {`,
            `  async fetch(request) {`,
            `    return (await site.fetch(request)) ?? (await ${fallback.call});`,
            `  },`,
            `};`,
          ].join("\n"),
        };
      },
    },
  };
  return [configPlugin, fetchablePlugin];
};
