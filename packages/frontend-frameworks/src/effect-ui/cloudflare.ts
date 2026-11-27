/**
 * The Cloudflare Workers deploy target for Effect UI. Builds and serves the
 * app with `@alchemy.run/cloudflare-runtime/vite`, which bundles a custom
 * `main` Worker or the handler `HtmlServerVite` generates for workerd.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@alchemy.run/cloudflare-runtime/vite";
import type { Plugin } from "vite";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { FrameworkError, makeDeployTarget } from "../core/index.ts";
import { ALCHEMY_CLOUDFLARE_VITE_INJECTED } from "../vinext/cloudflare.ts";
import { HTML_SERVER_PLUGIN_NAME, type EffectUITarget } from "./EffectUI.ts";

export type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";

const SPA = { notFoundHandling: "single-page-application" } as const;
const NOT_FOUND_PAGE = { notFoundHandling: "404-page" } as const;

/** The module `HtmlServerVite` builds as the `ssr` environment's input. */
const SERVER_ID = "virtual:@effect/ui/server";
/** The Worker that adapts it to a `fetch` handler. */
const WORKER_ID = "virtual:alchemy/effect-ui-worker";

/**
 * A page load that matches no file gets the app shell unless Effect UI
 * renders pages itself. On deploy it does when the build produced its
 * server handler (`serverOutDir`), which a custom `main` never builds with.
 * A prerendered build without a server answers with its own `404.html`.
 */
export const effectUIAssetDefaults = (
  output: BuildOutput,
  main: string | undefined,
): typeof SPA | typeof NOT_FOUND_PAGE | undefined =>
  main === undefined && output.serverModules !== undefined && output.serverModules.length > 0
    ? undefined
    : output.clientDirectory !== undefined &&
        NodeFS.existsSync(NodePath.join(output.clientDirectory, "404.html"))
      ? NOT_FOUND_PAGE
      : SPA;

/** The deepest directory containing both directories, resolved from `root`. */
const commonDirectory = (root: string, a: string, b: string): string => {
  const left = NodePath.resolve(root, a).split(NodePath.sep);
  const right = NodePath.resolve(root, b).split(NodePath.sep);
  let shared = 0;
  while (shared < left.length && left[shared] === right[shared]) shared++;
  return left.slice(0, shared).join(NodePath.sep) || NodePath.sep;
};

/**
 * Hand `HtmlServerVite`'s server to the Cloudflare plugin as the Worker.
 *
 * The plugin builds `virtual:@effect/ui/server`, which exports `handler`;
 * workerd wants a default export with `fetch`, so the Worker is a module that
 * re-exports the server (the plugin's prerender step imports the built entry
 * and reads `prerender` from it) and adds `fetch`. Without `serverOutDir` the
 * plugin writes no server, and the site deploys its prerendered pages alone.
 *
 * In dev the Worker renders every page in workerd, so the plugin's own Node
 * middleware stands down; its `configureServer` still runs, since the
 * `virtual:@effect/ui/document` template reads the dev server it records.
 */
const htmlServerWorker = (options: CloudflareVitePluginOptions): Plugin => {
  let serves = false;
  return {
    name: "alchemy:effect-ui-cloudflare",
    // After the app's plugins (`HtmlServerVite` sets the `ssr` input in its
    // own `config`), before the Cloudflare plugin reads the input.
    config(config) {
      const build = config.environments?.ssr?.build;
      const rolldownInput = build?.rolldownOptions?.input;
      const input = rolldownInput ?? build?.rollupOptions?.input;
      if (
        input === undefined ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.index !== SERVER_ID
      ) {
        return;
      }
      if (options.main !== undefined) {
        // The plugin owns the `ssr` environment: it builds the Worker
        // itself, or with no `serverOutDir` builds nothing to deploy.
        throw new FrameworkError({
          framework: "effect-ui",
          message:
            "HtmlServerVite.plugin generates the Worker and cannot be combined with main. Remove main to deploy its server, or remove the plugin for a custom Worker.",
        });
      }
      serves = true;
      const inputOptions =
        rolldownInput !== undefined ? build!.rolldownOptions! : build!.rollupOptions!;
      inputOptions.input = { index: WORKER_ID };
      // The Cloudflare plugin nests the client under `<outDir>/client` once
      // there is a Worker; the app's `build.outDir` is already the client's.
      // Server modules are named relative to the root `outDir`, so it moves
      // up to the directory holding both outputs (`dist` for `dist/client`
      // and `dist/server`).
      const client = config.environments?.client?.build?.outDir ?? config.build?.outDir ?? "dist";
      const server = build?.outDir;
      return {
        build: {
          outDir:
            server === undefined
              ? client
              : commonDirectory(NodePath.resolve(config.root ?? "."), client, server),
        },
        environments: { client: { build: { outDir: client } } },
      };
    },
    configResolved(config) {
      if (!serves || config.command !== "serve") return;
      const htmlServer = config.plugins.find((plugin) => plugin.name === HTML_SERVER_PLUGIN_NAME);
      const configureServer = htmlServer?.configureServer;
      if (htmlServer === undefined || typeof configureServer !== "function") return;
      Object.assign(htmlServer, {
        configureServer(this: unknown, ...args: Parameters<typeof configureServer>) {
          // Records the dev server for the document template, and drops the
          // post middleware that would render pages in Node.
          configureServer.apply(this as never, args);
        },
      });
    },
    resolveId: (id) => (id === WORKER_ID ? `\0${WORKER_ID}` : undefined),
    load: (id) =>
      id === `\0${WORKER_ID}`
        ? [
            `import { handler } from ${JSON.stringify(SERVER_ID)};`,
            `export * from ${JSON.stringify(SERVER_ID)};`,
            `export default { fetch: (request) => handler(request) };`,
          ].join("\n")
        : undefined,
  };
};

/**
 * The dev half of {@link effectUIAssetDefaults}: with no server to render
 * pages, the Worker's assets fall back to the shell, under the resource's own
 * `notFoundHandling`. The Cloudflare plugin reads `options.worker` when the
 * dev server starts, after this runs.
 */
const devAssetDefaults = (options: CloudflareVitePluginOptions): Plugin => ({
  name: "alchemy:effect-ui-cloudflare-assets",
  configResolved({ command, plugins }) {
    if (command !== "serve") return;
    const rendersPages =
      options.main === undefined &&
      plugins.some((plugin) => plugin.name === HTML_SERVER_PLUGIN_NAME);
    const worker = options.worker;
    if (rendersPages || worker === undefined) return;
    options.worker = {
      ...worker,
      assets: {
        ...worker.assets,
        notFoundHandling: worker.assets?.notFoundHandling ?? SPA.notFoundHandling,
      },
    };
  },
});

/**
 * `VITE_`-prefixed Worker env entries as `import.meta.env` defines for the dev
 * server. A build gets them from the build child's process env instead.
 */
const devEnvDefines = (env: Record<string, string>): Plugin => ({
  name: "alchemy:effect-ui-cloudflare-env",
  apply: "serve",
  config: () => ({
    define: Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        key.startsWith("VITE_") ? [[`import.meta.env.${key}`, JSON.stringify(value)]] : [],
      ),
    ),
  }),
});

/** Build and serve an Effect UI app as a Cloudflare Worker. */
export const makeEffectUICloudflareTarget = (
  options: CloudflareVitePluginOptions = {},
  /** The Worker's env, resolved to strings; its `VITE_` entries reach dev code. */
  env: Record<string, string> = {},
): EffectUITarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config: {},
    entry: options.main !== undefined ? { main: options.main } : undefined,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    vitePlugins: ({ root }) => {
      // Before Vite loads the app's config, so a config guarding its own
      // `cloudflare()` on this flag skips it, as with `Website.Vite`.
      process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
      // A fresh options object per build or dev server: the dev plugin
      // fills in its asset defaults on it.
      const pluginOptions: CloudflareVitePluginOptions = {
        ...options,
        main: options.main === undefined ? undefined : NodePath.resolve(root, options.main),
      };
      return [
        devEnvDefines(env),
        htmlServerWorker(pluginOptions),
        devAssetDefaults(pluginOptions),
        cloudflareVitePlugin(pluginOptions) as Plugin,
      ];
    },
  });

export const target = makeEffectUICloudflareTarget;
export default makeEffectUICloudflareTarget;
