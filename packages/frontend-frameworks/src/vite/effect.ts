/**
 * Effectful (mount-design) delivery descriptors for the generic Vite
 * integration — Serve/DESIGN.md.
 *
 * Production delivery lives in the deploy target (`./aws.ts` generates the
 * additive `makeFrameworkFunctionHandler` Lambda entry; the framework's
 * fetch — with the user's `mount(Site)` inside it — serves ALL HTTP).
 *
 * Dev delivery is the mount itself: the user's server entry (TanStack's
 * `src/server.ts`) runs natively inside the framework's own Vite dev
 * server, so there is no front middleware and no generated dispatch — the
 * only thing this module contributes to dev is a config-only plugin that
 * keeps `alchemy` external to vite's SSR transform (one module instance,
 * loaded by the host runtime) with bun-first resolve conditions under a
 * bun host.
 *
 * This module is Vite-plugin callback code, not an Effect service. It is
 * self-contained by convention (this package deliberately has no alchemy
 * dependency).
 */
import { fileURLToPath } from "node:url";
import type * as ViteModule from "vite";

/**
 * Effectful delivery options for a Vite build/dev invocation — plain data
 * assembled by alchemy's Vite composite from the construct's collect-only
 * stamp (`effectOptions` on the FrameworkSite config).
 */
export interface ViteEffectOptions {
  /**
   * The user's site module (the impl anchor, `main: import.meta.url`) as
   * an absolute path or `file://` URL.
   */
  readonly main: string;
}

/**
 * Convert the `main` anchor (path or `file://` URL) to a forward-slash
 * absolute path. The anchor arrives absolute from the construct
 * (`main: import.meta.url`), so it is used VERBATIM apart from the URL
 * unwrap — `NodePath.resolve` would prepend a drive letter on Windows and
 * emit backslashes, which are invalid in the generated ESM import
 * specifiers (vite and rolldown both want `C:/...` style there).
 */
export const effectMainPath = (main: string): string =>
  (main.startsWith("file://") ? fileURLToPath(main) : main).replaceAll(
    "\\",
    "/",
  );

export interface EffectDevPluginArgs {
  readonly effect: ViteEffectOptions;
}

/**
 * The dev config plugin (`apply: "serve"` — never part of a production
 * build): one alchemy instance for the whole dev server. The site module's
 * alchemy imports and the user mount's `alchemy/Serve` import resolve
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
  name: "alchemy-vite-effect-dev",
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
