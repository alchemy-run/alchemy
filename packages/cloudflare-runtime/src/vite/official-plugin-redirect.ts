import * as NodeModule from "node:module";

/**
 * Set while Alchemy injects its own Cloudflare plugin into a Vite run (see
 * `ALCHEMY_CLOUDFLARE_VITE_INJECTED` in `@alchemy.run/cloudflare`). Only then
 * does an official `cloudflare()` stand down.
 */
const INJECTED = "ALCHEMY_CLOUDFLARE_VITE_INJECTED";

/** The official package's entry, in any package manager's layout. */
const ENTRY = /[\\/]@cloudflare[\\/]vite-plugin[\\/]dist[\\/]index\.mjs$/;

/** Where the wrapper finds the function that disables official plugins. */
const NEUTRALIZE = Symbol.for("@alchemy.run/cloudflare-runtime/neutralize-official-vite-plugin");

type Neutralize = (plugins: unknown) => unknown;

/**
 * The official package with `cloudflare()` wrapped: while Alchemy injects
 * its plugin, the plugins it returns are disabled as soon as they exist.
 */
const MARKER = "alchemy:official-cloudflare-vite-plugin";

const wrapper = (real: string) => `// ${MARKER}
import * as real from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
export function cloudflare(...args) {
  const plugins = real.cloudflare(...args);
  const neutralize = globalThis[Symbol.for(${JSON.stringify(NEUTRALIZE.description)})];
  return typeof neutralize === "function" ? neutralize(plugins) : plugins;
}
`;

const registered = Symbol.for("@alchemy.run/cloudflare-runtime/official-vite-plugin-redirect");

/**
 * Makes every import of `@cloudflare/vite-plugin` in this process return the
 * package with `cloudflare()` wrapped, so an official plugin stands down
 * wherever a project's `vite.config.ts` is evaluated while Alchemy injects its
 * own: not only in the Vite server Alchemy creates, whose config hook
 * neutralizes the instances it is given, but also in servers a framework
 * creates from the same file, such as React Router's child compiler. Those
 * get fresh instances Alchemy's plugin never sees.
 *
 * Imports are matched by the file they resolve to, since Vite's config
 * bundler rewrites the package name into an absolute file URL. Node redirects
 * an import whenever it is resolved. Bun only lets a runtime plugin replace a
 * file it hasn't loaded yet, so this must run before the
 * project's config is first evaluated; Alchemy's plugin factory, which every
 * Alchemy-driven Vite run calls first, does that.
 */
export const redirectOfficialCloudflareVitePlugin = (neutralize: Neutralize): void => {
  const state = globalThis as typeof globalThis & {
    [registered]?: true;
    [NEUTRALIZE]?: Neutralize;
  };
  state[NEUTRALIZE] = (plugins) => (process.env[INJECTED] === "1" ? neutralize(plugins) : plugins);
  if (state[registered]) return;
  state[registered] = true;

  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (bun !== undefined) {
    bun.plugin({
      name: "alchemy-official-cloudflare-vite-plugin",
      setup(build) {
        // The wrapper imports the real entry under a query, which the
        // anchored filter doesn't match, so Bun loads that one as is.
        build.onLoad({ filter: ENTRY }, ({ path }) => ({
          loader: "js",
          contents: wrapper(`${path}?real`),
        }));
      },
    });
    return;
  }

  if (typeof NodeModule.registerHooks !== "function") return;
  NodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const fromWrapper = decodeURIComponent(context.parentURL ?? "").includes(MARKER);
      if (fromWrapper || !ENTRY.test(new URL(resolved.url).pathname)) return resolved;
      return {
        url: `data:text/javascript,${encodeURIComponent(wrapper(resolved.url))}`,
        format: "module",
        shortCircuit: true,
      };
    },
  });
};

interface BunRuntime {
  plugin(plugin: {
    name: string;
    setup(build: {
      onLoad(
        options: { filter: RegExp },
        callback: (args: { path: string }) => { contents: string; loader: "js" },
      ): void;
    }): void;
  }): void;
}
