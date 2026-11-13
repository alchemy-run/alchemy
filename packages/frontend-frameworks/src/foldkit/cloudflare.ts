/**
 * The Cloudflare Workers deploy target for Foldkit. Builds and serves the app
 * with `@alchemy.run/cloudflare-runtime/vite`, which bundles a custom `main`
 * Worker or the handler Foldkit's `ssr.build` generates for workerd.
 */
import * as NodePath from "node:path";
import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@alchemy.run/cloudflare-runtime/vite";
import type { Plugin } from "vite";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { makeDeployTarget } from "../core/index.ts";
import { ALCHEMY_CLOUDFLARE_VITE_INJECTED } from "../vinext/cloudflare.ts";
import type { FoldkitTarget } from "./Foldkit.ts";

export type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";

const SPA = { notFoundHandling: "single-page-application" } as const;

/**
 * A page load that matches no file gets the app shell unless Foldkit renders
 * pages itself. On deploy it does when the build produced its generated
 * handler (`ssr.build`), which a custom `main` never builds with.
 */
export const foldkitAssetDefaults = (
  output: BuildOutput,
  main: string | undefined,
): typeof SPA | undefined =>
  main === undefined && output.serverModules !== undefined && output.serverModules.length > 0
    ? undefined
    : SPA;

/**
 * The dev half of {@link foldkitAssetDefaults}: Foldkit's dev host
 * (`foldkit-ssr`, present whenever the app sets `ssr`) renders pages unless a
 * custom `main` serves them, when it stands down for the Worker. Otherwise
 * the Worker's assets fall back to the shell, under the resource's own
 * `notFoundHandling`. The Cloudflare plugin reads `options.worker` when the
 * dev server starts, after this runs.
 */
const devAssetDefaults = (options: CloudflareVitePluginOptions): Plugin => ({
  name: "alchemy:foldkit-cloudflare-assets",
  configResolved({ command, plugins }) {
    if (command !== "serve") return;
    const rendersPages =
      options.main === undefined && plugins.some((plugin) => plugin.name === "foldkit-ssr");
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
  name: "alchemy:foldkit-cloudflare-env",
  apply: "serve",
  config: () => ({
    define: Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        key.startsWith("VITE_") ? [[`import.meta.env.${key}`, JSON.stringify(value)]] : [],
      ),
    ),
  }),
});

/** Build and serve a Foldkit app as a Cloudflare Worker. */
export const makeFoldkitCloudflareTarget = (
  options: CloudflareVitePluginOptions = {},
  /** The Worker's env, resolved to strings; its `VITE_` entries reach dev code. */
  env: Record<string, string> = {},
): FoldkitTarget =>
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
        devAssetDefaults(pluginOptions),
        cloudflareVitePlugin(pluginOptions) as Plugin,
      ];
    },
  });

export const target = makeFoldkitCloudflareTarget;
export default makeFoldkitCloudflareTarget;
