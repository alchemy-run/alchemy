/**
 * Effectful-delivery descriptors + the dev config plugin for SvelteKit
 * (Serve/DESIGN.md, the mount design).
 *
 * HTTP delivery — dev AND prod, on every cloud — is the user's
 * `hooks.server.ts` mount (`site.fetch(event.request, ...) ??
 * resolve(event)`), which runs natively inside kit. Nothing here
 * dispatches requests: the only dev contribution is a config-only vite
 * plugin that keeps `alchemy` external to vite's SSR transform so the
 * mount, the site module, and everything they pull share ONE module
 * instance loaded by the host runtime (bun under `alchemy dev`), with
 * bun-first resolve conditions under a bun host so alchemy (and
 * distilled) load from `src`.
 *
 * This module is Vite-plugin callback code (like `UserConfig.ts`), not an
 * Effect service.
 */
import { fileURLToPath } from "node:url";
import type * as ViteModule from "vite";

/**
 * Effectful delivery options for a SvelteKit build/dev invocation — plain
 * data assembled by alchemy's SvelteKit source provider from the
 * construct's collect-only stamp.
 */
export interface SvelteKitEffectOptions {
  /**
   * The user's site module (the impl anchor, `main: import.meta.url`) as
   * an absolute path or `file://` URL.
   */
  readonly main: string;
  /**
   * Legacy carriage from the retired routes-scoped design — still threaded
   * by descriptors for hash stability, consumed by nothing (routing lives
   * in the user's mount).
   * @deprecated
   */
  readonly routes?: ReadonlyArray<string> | undefined;
  /** Durable Object class names from the site's exports (build only). */
  readonly durableObjects?: ReadonlyArray<string> | undefined;
  /** Workflow class names from the site's exports (build only). */
  readonly workflows?: ReadonlyArray<string> | undefined;
  /** Stack identity (markers for the dev env; baked into wf bridges). */
  readonly stack?:
    | { readonly name: string; readonly stage: string }
    | undefined;
}

/**
 * Convert the `main` anchor (path or `file://` URL) to a forward-slash
 * absolute path. The anchor arrives absolute from the construct
 * (`main: import.meta.url`), so it is used VERBATIM apart from the URL
 * unwrap — `NodePath.resolve` would prepend a drive letter on Windows and
 * emit backslashes, which are invalid in the generated ESM import
 * specifiers.
 */
export const effectMainPath = (main: string): string =>
  (main.startsWith("file://") ? fileURLToPath(main) : main).replaceAll(
    "\\",
    "/",
  );

export interface EffectDevPluginArgs {
  readonly effect: SvelteKitEffectOptions;
}

/**
 * The dev config plugin (`apply: "serve"` — never part of a production
 * build): one alchemy instance for the whole dev server. The site module's
 * alchemy imports and the hooks mount's `alchemy/Serve` import resolve
 * through the host runtime instead of a vite-transformed
 * (linked-workspace) copy of the alchemy graph. Under a bun host (the
 * `alchemy dev` sidecar), externalized imports resolve with the `bun`
 * condition FIRST so alchemy (and distilled) load from `src` — mirroring
 * the test runner and `FunctionBundle`: a fresh workspace never silently
 * exercises a stale `lib` build.
 */
export const makeEffectDevPlugin = (
  _args: EffectDevPluginArgs,
): ViteModule.Plugin => ({
  name: "alchemy-sveltekit-effect-dev",
  apply: "serve",
  enforce: "pre",
  config: () => ({
    ssr: {
      external: ["alchemy"],
      ...(typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
        ? {
            resolve: {
              conditions: ["bun", "module", "node", "development|production"],
              externalConditions: ["bun", "node"],
            },
          }
        : undefined),
    },
  }),
});
