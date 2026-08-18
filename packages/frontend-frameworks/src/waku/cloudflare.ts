// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * The Cloudflare Workers deploy target for `@alchemy.run/frontend-frameworks/waku` — the ONLY
 * module in this package (besides the bundled `./adapter` fork it selects)
 * that imports Cloudflare-specific code. The framework half (`./Waku.ts`)
 * receives this target as a value and stays platform-neutral.
 *
 * Default export: a `(config) => WakuTarget` factory, the shape
 * `resolveDeployTarget` expects from a target module specifier. The config is
 * the cloudflare vite plugin's options (worker name/bindings/assets,
 * compatibility date/flags) — exactly what the e2e harness carries at
 * `target.cloudflare.worker`.
 */
import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@alchemy.run/cloudflare-runtime/vite";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBSITE_ENTRY_ID,
  wakuEffectEntryPlugin,
  type WakuEffectOptions,
} from "./effect-entry.ts";
import { WAKU_SERVER_ENTRY_PATH, type WakuTarget } from "./Waku.ts";

export type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
export {
  WEBSITE_ENTRY_ID,
  makeWakuEffectEntrySource,
  type WakuEffectOptions,
} from "./effect-entry.ts";
export type { WakuTarget, WakuTargetContext } from "./Waku.ts";

/**
 * The Cloudflare target's configuration: the cloudflare vite plugin's
 * options plus the effectful (mount-design) delivery descriptor an
 * effectful `Cloudflare.Website.Waku` threads through the source provider.
 */
export interface WakuCloudflareTargetConfig
  extends CloudflareVitePluginOptions {
  /**
   * Effectful delivery (Serve/DESIGN.md): when set, the deployed worker
   * entry becomes the generated `virtual:alchemy:website-entry` wrapper —
   * waku's fetch grafted verbatim (the user's mount middleware runs inside
   * it) plus the program's non-fetch dispatch and DO/Workflow class
   * exports. Plain data only — it crosses the build-child boundary.
   */
  readonly effect?: WakuEffectOptions | undefined;
}

/** Inputs for {@link makeWakuPluginOptions} (exported for testing). */
export interface WakuPluginOptionsInputs {
  /** Absolute project root (a relative user `main` resolves against it). */
  readonly root: string;
  /** Directory of the project's installed `waku` package. */
  readonly wakuDirectory: string;
  /** User cloudflare plugin options (the target's config). */
  readonly pluginOptions?: CloudflareVitePluginOptions | undefined;
  /**
   * Effectful delivery: the entry becomes the generated
   * `virtual:alchemy:website-entry` wrapper (a user `main` is never
   * forwarded on the effectful arm — the construct anchors the program's
   * module with it instead).
   */
  readonly effect?: WakuEffectOptions | undefined;
}

/**
 * Waku requires `AsyncLocalStorage` on the worker runtime (its server entry
 * imports `node:async_hooks` at the top level), so a config without any
 * Node.js compatibility flag would fail at runtime with a module-resolution
 * error. When the user enables neither `nodejs_als` nor
 * `nodejs_compat`/`nodejs_compat_v2` (each of which provides ALS), the
 * target defaults to the minimal `nodejs_als`.
 */
const withNodejsAls = (flags: Array<string> | undefined): Array<string> => {
  const hasAls = flags?.some(
    (flag) =>
      flag === "nodejs_als" ||
      flag === "nodejs_compat" ||
      flag === "nodejs_compat_v2",
  );
  return hasAls ? [...flags!] : [...(flags ?? []), "nodejs_als"];
};

/**
 * The cloudflare plugin options for a waku project: user options with `main`
 * defaulted to waku's rsc worker entry, the rsc/ssr environment topology, and
 * `compatibilityFlags` defaulted to include `nodejs_als` (required by waku's
 * server entry) unless the user already enabled ALS or full nodejs_compat.
 *
 * An explicit `main` is mandatory either way: waku's rsc environment declares
 * two rolldown inputs (`index` + `build`) while the dev plugin asserts exactly
 * one entry. A USER `main` (the deploy target's user-entry seam — a worker
 * entry that wraps `virtual:waku/server-entry` and re-exports Durable Object
 * classes) takes precedence over waku's own entry and is resolved against the
 * project root; without one, waku's rsc server entry is pinned as before.
 */
export const makeWakuPluginOptions = (
  inputs: WakuPluginOptionsInputs,
): CloudflareVitePluginOptions => {
  const userMain = inputs.pluginOptions?.main;
  return {
    ...inputs.pluginOptions,
    main:
      inputs.effect !== undefined
        ? // Effectful delivery: the generated wrapper is the worker entry.
          // The options plugin passes virtual ids through untouched and
          // wraps them in its `\0distilled:worker-entry:` module, so unenv
          // injection and the dev HMR handshake apply as to a file entry.
          WEBSITE_ENTRY_ID
        : userMain !== undefined
          ? NodePath.isAbsolute(userMain)
            ? userMain
            : NodePath.resolve(inputs.root, userMain)
          : NodePath.join(inputs.wakuDirectory, WAKU_SERVER_ENTRY_PATH),
    viteEnvironments: { entry: "rsc", children: ["ssr"] },
    compatibilityFlags: withNodejsAls(inputs.pluginOptions?.compatibilityFlags),
  };
};

/**
 * Build the Cloudflare deploy target for waku:
 *
 * - `adapter` — this package's wrangler-free fork of waku's cloudflare
 *   adapter (`@alchemy.run/frontend-frameworks/waku/adapter`): behavior-identical to upstream
 *   except `buildEnhancers: []`, dropping the sole wrangler-file writer.
 * - `vitePlugins` — `@alchemy.run/cloudflare-runtime/vite` with `main`
 *   set to the user's own worker entry when the config carries one (the
 *   user-entry seam), or pinned to waku's rsc worker entry otherwise, plus
 *   the `{ entry: "rsc", children: ["ssr"] }` environment topology. Injected
 *   inside waku's `vite.plugins` (before waku's own plugins), so in dev the
 *   rsc environment runs in workerd and the workerd proxy middleware
 *   registers ahead of waku's Node request bridge.
 * - `entry` — surfaces the config's `main` as the generic user-entry
 *   carriage, so the platform-neutral framework half can pin the built
 *   user-entry chunk as `serverModules[0]`.
 * - `bundle` — the workerd resolve conditions and `cloudflare:` externals for
 *   any pass that bundles server code for this target.
 */
export const makeWakuCloudflareTarget = (
  config?: WakuCloudflareTargetConfig,
): WakuTarget<WakuCloudflareTargetConfig | undefined> => {
  const { effect, ...pluginOptions } = config ?? {};
  return makeDeployTarget({
    platform: "cloudflare",
    config,
    entry:
      effect !== undefined
        ? // The virtual wrapper is the worker entry: surfaced as the
          // user-entry carriage so the platform-neutral framework half pins
          // the wrapper chunk as `serverModules[0]` (virtual ids get the
          // facade-`includes` selection in `Waku.ts`).
          { main: WEBSITE_ENTRY_ID }
        : pluginOptions.main !== undefined
          ? { main: pluginOptions.main }
          : undefined,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    adapter: () =>
      Effect.try({
        try: () =>
          fileURLToPath(
            import.meta
              .resolve("@alchemy.run/frontend-frameworks/waku/adapter"),
          ),
        catch: (cause) =>
          new DeployTargetError({
            platform: "cloudflare",
            message:
              "Failed to resolve the @alchemy.run/frontend-frameworks/waku adapter module",
            cause,
          }),
      }),
    vitePlugins: (context) =>
      Effect.sync(() => [
        cloudflareVitePlugin(
          makeWakuPluginOptions({
            root: context.root,
            wakuDirectory: context.wakuDirectory,
            pluginOptions,
            effect,
          }),
        ),
        ...(effect !== undefined
          ? [
              wakuEffectEntryPlugin({
                effect,
                environments: ["rsc", "ssr"],
              }),
            ]
          : []),
      ]),
  });
};

export default makeWakuCloudflareTarget;
