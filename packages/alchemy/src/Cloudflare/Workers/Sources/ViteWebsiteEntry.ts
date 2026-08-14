import fs from "node:fs";
import nodePath from "node:path";
import type * as vite from "vite";
import type { ViteEffectEntry } from "../ViteChild.shared.ts";

/**
 * The virtual module id of the generated effectful-Website worker entry
 * (DESIGN §6.2a). `makeViteSource` sets the Cloudflare vite plugin's `main`
 * to this id when `SourceContext.entry` carries wrapper delivery; the
 * options plugin passes virtual ids through untouched and wraps them in the
 * `\0distilled:worker-entry:` module, so unenv injection and the dev HMR
 * export-type handshake apply to the wrapper exactly as to a file entry.
 */
export const WEBSITE_ENTRY_ID = "virtual:alchemy:website-entry";
const RESOLVED_WEBSITE_ENTRY_ID = `\0${WEBSITE_ENTRY_ID}`;

/**
 * Node-only packages reachable from the `alchemy/Cloudflare` provider barrel
 * that crash at module evaluation inside workerd. The deployed rolldown/vite
 * *build* tree-shakes them away (only the runtime slice of the barrel is
 * used), but the dev module runner evaluates every module in the graph — so
 * they are aliased to inert stubs in the worker environments. Each stub must
 * satisfy the named-export surface its importer binds.
 */
const NODE_STUBS: Record<string, string> = {
  // `workerd` runs binary-path resolution at module scope (path.resolve on
  // an unshimmed node:path binding). cloudflare-runtime only reads the
  // binary path + metadata, never inside a worker.
  workerd: [
    `export default "";`,
    `export const compatibilityDate = "";`,
    `export const version = "";`,
  ].join("\n"),
};
const STUB_PREFIX = "\0virtual:alchemy:node-stub:";

export interface WebsiteEntryPluginOptions {
  /** Plain-data wrapper description (routes, site module path, exports). */
  readonly entry: ViteEffectEntry;
  /**
   * Worker environment names, entry environment first (from
   * `viteEnvironments`, default `["ssr"]`). These get the
   * `__ALCHEMY_RUNTIME__` define; the entry environment is also where the
   * framework's own configured input is captured from.
   */
  readonly environments: readonly [string, ...string[]];
}

/** POSIX-normalize a path for use as a vite module specifier. */
const toSpecifier = (p: string) => p.replace(/\\/g, "/");

/**
 * Extract the first configured input of the entry environment from the
 * (progressively merged) user config — the framework's own server entry
 * (e.g. TanStack's `virtual:tanstack-start-server-entry`, SolidStart's
 * `src/entry-server.tsx`). Runs in the plugin's `config` hook, which vite
 * calls after the config-file (framework) plugins' hooks and before the
 * Cloudflare options plugin replaces the input with the wrapper id.
 */
const captureFrameworkEntry = (
  userConfig: vite.UserConfig,
  entryEnvironment: string,
): string | undefined => {
  const build = userConfig.environments?.[entryEnvironment]?.build as
    | {
        rollupOptions?: { input?: unknown };
        rolldownOptions?: { input?: unknown };
      }
    | undefined;
  const input = build?.rolldownOptions?.input ?? build?.rollupOptions?.input;
  const first =
    typeof input === "string"
      ? input
      : Array.isArray(input)
        ? (input[0] as string | undefined)
        : input && typeof input === "object"
          ? (Object.values(input)[0] as string | undefined)
          : undefined;
  if (
    first === undefined ||
    // Never delegate to ourselves (a re-entrant config pass may already
    // carry the wrapper id, plain or `\0distilled:worker-entry:`-wrapped).
    first.includes(WEBSITE_ENTRY_ID) ||
    // A `\0` id from another plugin's config output is not a stable
    // importable specifier.
    first.startsWith("\0")
  ) {
    return undefined;
  }
  // Absolutize path-like inputs against the vite root so the generated
  // dynamic import resolves regardless of the build child's cwd; virtual
  // ids and bare specifiers pass through and resolve via plugins (same
  // semantics as the Cloudflare options plugin's `resolveInputPath`).
  const root = nodePath.resolve(userConfig.root ?? ".");
  if (nodePath.isAbsolute(first)) return first;
  if (first.startsWith("./") || first.startsWith("../")) {
    return nodePath.resolve(root, first);
  }
  const resolved = nodePath.resolve(root, first);
  return fs.existsSync(resolved) ? resolved : first;
};

/**
 * Generate the wrapper module source. Import order is load-bearing:
 * `alchemy/Serve/Worker` must evaluate before the user's site module so
 * `globalThis.__ALCHEMY_RUNTIME__` is stamped (at that module's evaluation)
 * before any user code can observe it.
 */
const generateWebsiteEntry = (
  entry: ViteEffectEntry,
  frameworkEntry: string | undefined,
): string => {
  const doClasses = entry.exports.filter((e) => e.kind === "durableObject");
  const wfClasses = entry.exports.filter((e) => e.kind === "workflow");
  if (wfClasses.length > 0) {
    // The `alchemy/Serve/Worker` shell exposes a DurableObject bridge but no
    // Workflow bridge yet; emitting a class that cannot run would fail at
    // workerd startup with a much worse message.
    throw new Error(
      `Workflow exports (${wfClasses.map((e) => e.name).join(", ")}) are not ` +
        `yet supported on effectful Website wrapper delivery. Deploy the ` +
        `Workflow on a dedicated Cloudflare.Worker instead.`,
    );
  }
  const framework = frameworkEntry
    ? // The framework graph loads lazily on first fallback.
      `() => import(${JSON.stringify(toSpecifier(frameworkEntry))})`
    : // No framework server entry (SPA / assets-only site): requests
      // outside the effect routes fall through to the static asset layer,
      // which applies `notFoundHandling` (including the SPA index.html
      // fallback).
      `() => Promise.resolve({
  default: {
    fetch: (request, env) =>
      env?.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response("Not Found", { status: 404 }),
  },
})`;
  return [
    // Evaluates first: stamps __ALCHEMY_RUNTIME__ at module evaluation.
    `import { makeWebsiteExports, DurableObjectBridge } from "alchemy/Serve/Worker";`,
    `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";`,
    `import Site from ${JSON.stringify(toSpecifier(entry.mainPath))};`,
    `export default makeWebsiteExports(WorkerEntrypoint, {`,
    `  site: Site,`,
    `  routes: ${JSON.stringify(entry.routes)},`,
    `  framework: ${framework},`,
    `});`,
    ...(doClasses.length > 0
      ? [
          `const __alchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: Site });`,
          ...doClasses.map(
            (e) =>
              `export class ${e.name} extends __alchemyDurableObjectBridge(${JSON.stringify(e.name)}) {}`,
          ),
        ]
      : []),
    "",
  ].join("\n");
};

/**
 * The alchemy-injected vite plugins for effectful Websites (wrapper
 * delivery). Composed next to the Cloudflare plugin in `viteDev` /
 * `viteBuildInProcess` when the Worker carries a {@link ViteEffectEntry}:
 *
 * 1. resolves and loads {@link WEBSITE_ENTRY_ID} with the generated
 *    DESIGN §6.2a wrapper (site import + `makeWebsiteExports` + DO stubs);
 * 2. defines `globalThis.__ALCHEMY_RUNTIME__` as `true` in every *worker*
 *    environment (never the client env) so plan-only `host.bind` branches
 *    fold at build time — the wrapper's `alchemy/Serve/Worker` import also
 *    stamps the flag at module evaluation, so correctness holds even where
 *    the define can't reach;
 * 3. captures the framework's own entry-environment input before the
 *    Cloudflare options plugin overwrites it with the wrapper id, and hands
 *    it to the wrapper as the fallback fetch.
 *
 * The capture (3) is a separate `enforce: "pre"` plugin: the Cloudflare
 * options plugin REPLACES the entry environment's `input` with the wrapper
 * id in its own (normal-enforce) `config` hook, and it sits earlier in the
 * composed plugin array — a normal-enforce capture would only ever observe
 * the already-replaced input (every SSR route then 404s through the
 * assets-only fallback). Framework config plugins (e.g. TanStack Start's)
 * are `enforce: "pre"` in the user's config file, and config-file plugins
 * order before injected inline plugins within the same enforce bucket, so
 * the pre capture still sees the framework's input. The normal-enforce
 * capture in the main plugin remains as a fallback for frameworks that
 * only set their input in a normal-enforce hook (the wrapper-id guard in
 * `captureFrameworkEntry` keeps it from ever capturing the replacement).
 */
export const websiteEntryPlugin = (
  options: WebsiteEntryPluginOptions,
): vite.Plugin[] => {
  const [entryEnvironment] = options.environments;
  let frameworkEntry: string | undefined;
  const capturePlugin: vite.Plugin = {
    name: "alchemy:website-entry:capture-framework-entry",
    enforce: "pre",
    config(userConfig) {
      frameworkEntry ??= captureFrameworkEntry(userConfig, entryEnvironment);
    },
  };
  const mainPlugin: vite.Plugin = {
    name: "alchemy:website-entry",
    config(userConfig) {
      frameworkEntry ??= captureFrameworkEntry(userConfig, entryEnvironment);
      return {
        resolve: {
          // Top-level so every environment (and the dep optimizer) sees it;
          // no client module imports these packages, so the reach is safe.
          alias: Object.keys(NODE_STUBS).map((find) => ({
            find,
            replacement: `${STUB_PREFIX}${find}`,
          })),
        },
      };
    },
    configEnvironment(name) {
      if (options.environments.includes(name)) {
        return {
          define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
          optimizeDeps: {
            // The worker entry is a virtual module, so vite's dep scanner
            // finds none of the wrapper graph up front — `effect` (and the
            // rest of the alchemy runtime) would be "discovered" lazily on
            // the first request, triggering a mid-request re-optimize whose
            // stale-hash window breaks the workerd module runner
            // ("file does not exist ... in the optimize deps directory").
            // Exclude the graph so the module runner transforms it as
            // source; results are cached per module after the first load.
            exclude: [
              "effect",
              "alchemy",
              "@effect/platform-node",
              "@effect/platform-bun",
              "@alchemy.run/cloudflare-runtime",
              "@distilled.cloud/cloudflare",
              "@distilled.cloud/core",
              ...Object.keys(NODE_STUBS),
            ],
          },
        };
      }
    },
    resolveId(id) {
      if (id === WEBSITE_ENTRY_ID || id === RESOLVED_WEBSITE_ENTRY_ID) {
        return RESOLVED_WEBSITE_ENTRY_ID;
      }
      if (id.startsWith(STUB_PREFIX)) {
        return id;
      }
    },
    load(id) {
      if (id === RESOLVED_WEBSITE_ENTRY_ID) {
        return generateWebsiteEntry(options.entry, frameworkEntry);
      }
      if (id.startsWith(STUB_PREFIX)) {
        return NODE_STUBS[id.slice(STUB_PREFIX.length)];
      }
    },
  };
  return [capturePlugin, mainPlugin];
};
