import type { BasePluginOptions } from "../rolldown/options.ts";
import {
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "../rolldown/plugins/index.ts";
import type {
  BindingHooks,
  RuntimeServices,
  RuntimeWorker,
} from "../core/index.ts";
import type * as Context from "effect/Context";
import type * as vite from "vite";
import { dev } from "./dev-plugin.ts";
import { preview } from "./preview-plugin.ts";

export interface CloudflareVitePluginDevOptions {
  /**
   * Where the Worker request-proxy middleware registers relative to the
   * `configureServer` post middlewares of other plugins.
   *
   * - `"post"` (default): append in plugin order. Required by frameworks whose
   *   own dev middlewares must see requests first (e.g. Astro's prerender
   *   handler and dev handler).
   * - `"pre"`: insert directly after Vite's internal middlewares, ahead of the
   *   post middlewares other plugins registered. Use this when appending the
   *   Cloudflare plugin after a framework's config-file plugins and the
   *   framework registers its own Node request-bridge middleware that cannot
   *   handle the Worker environment (e.g. Waku's RSC bridge, which assumes a
   *   runnable Node environment).
   *
   * @default "post"
   */
  middlewareOrder?: "pre" | "post";
}

export interface CloudflareVitePluginOptions<
  B extends BindingHooks = BindingHooks,
> extends BasePluginOptions {
  worker?: Omit<
    RuntimeWorker<B>,
    "compatibilityDate" | "compatibilityFlags" | "modules"
  >;
  context?: Context.Context<RuntimeServices>;
  dev?: CloudflareVitePluginDevOptions;
  /**
   * Marks this instance as injected by an orchestrator (Alchemy's
   * dev/build runs, a framework integration) that supplies the fully
   * resolved worker options. A NON-injected instance — the one an app's
   * own `vite.config.ts` declares so plain `vite build`/`vite dev` work
   * without the orchestrator — stands down automatically when an injected
   * instance is present in the same config (see the `apply` guard below),
   * so configs no longer need the `ALCHEMY_CLOUDFLARE_VITE_INJECTED`
   * env-var ternary.
   *
   * @internal
   */
  injected?: boolean;
}

/**
 * Marker property stamped on every plugin object of an injected instance.
 *
 * Detection goes through the config's plugin OBJECTS (not module state):
 * the orchestrator's instance and the config-file instance may come from
 * different copies of this module (the app's `node_modules` vs the
 * orchestrator's), so a module-level flag would not be shared between
 * them. A well-known property on the plugin objects travels with the
 * config regardless of which copy created them.
 */
const INJECTED_MARKER = "__alchemyCloudflareInjected";

/**
 * Whether an injected Cloudflare plugin instance is present in a config's
 * plugin tree. Async entries are ignored: the orchestrators always pass
 * their instance as a plain array in the inline config, so an injected
 * instance is never behind a Promise.
 */
const hasInjectedInstance = (option: vite.PluginOption): boolean => {
  if (Array.isArray(option)) return option.some(hasInjectedInstance);
  return (
    typeof option === "object" && option !== null && INJECTED_MARKER in option
  );
};

/** Evaluate a plugin's original `apply` clause (absent means always). */
const originalApplies = (
  apply: vite.Plugin["apply"],
  config: vite.UserConfig,
  env: vite.ConfigEnv,
): boolean => {
  if (apply === undefined) return true;
  if (typeof apply === "function") return apply(config, env);
  return apply === env.command;
};

export default function cloudflareVitePlugin(
  options: CloudflareVitePluginOptions = {},
): vite.PluginOption {
  const plugins = [
    optionsPlugin.vite(options),
    cloudflareExternalsPlugin.vite(options),
    nodejsAlsPlugin.vite(options),
    nodejsImportWarningPlugin.vite(options),
    nodejsUnenvPlugin.vite(options),
    virtualModulesPlugin.vite(options),
    wasmInitPlugin.vite(options),
    additionalModulesPlugin.vite(options),
    {
      name: "distilled-cloudflare:rsc",
      enforce: "pre",
      config() {
        return { rsc: { serverHandler: false } } as vite.UserConfig;
      },
    } as vite.Plugin,
    ...dev(options),
    preview(options),
    // Some of the composed plugins are conditional (e.g. the nodejs-compat
    // family) and resolve to `null`; filter them out so integrations that
    // post-process the returned plugins don't have to handle sparse entries.
  ].filter((plugin): plugin is vite.Plugin => plugin !== null);
  if (options.injected) {
    for (const plugin of plugins) {
      Object.defineProperty(plugin, INJECTED_MARKER, { value: true });
    }
  } else {
    // Self-deduplication: Vite evaluates `apply` BEFORE a plugin enters the
    // pipeline, so a standing-down instance runs no hooks, boots no
    // workerd, and never appears in `configResolved.plugins` — the
    // name-based cross-plugin lookups can only find the injected instance.
    for (const plugin of plugins) {
      const apply = plugin.apply;
      plugin.apply = (config, env) =>
        !hasInjectedInstance(config.plugins ?? []) &&
        originalApplies(apply, config, env);
    }
  }
  return plugins;
}
