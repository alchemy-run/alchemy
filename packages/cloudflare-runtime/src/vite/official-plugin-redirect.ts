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
 * its plugin, the plugins it returns are disabled as soon as they exist. It
 * has no top-level await, so Node can also `require()` it. (Under Bun, a
 * `require()` by path after the entry was imported throws; the package only
 * exports an `import` condition, so nothing requires it by name.)
 *
 * `real` is the entry's URL with a `?real` query. The anchored `ENTRY` test
 * doesn't match it, so both runtimes load the real file there instead of the
 * wrapper again. (Matching on the importer would not do: `require()` drops
 * the wrapper's own query from its URL.) It is its own module, so a process
 * that loaded the entry before registering evaluates the package a second
 * time; Alchemy registers first.
 */
const wrapper = (real: string) => `
import * as real from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
export function cloudflare(...args) {
  const plugins = real.cloudflare(...args);
  const neutralize = globalThis[Symbol.for(${JSON.stringify(NEUTRALIZE.description)})];
  return typeof neutralize === "function" ? neutralize(plugins) : plugins;
}
`;

/** Marks the Node URL of the wrapper: the real entry's URL with this query. */
const WRAPPER_SUFFIX = "?alchemy-wrapper";

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
 * every later `import`, and a `require()` unless the entry was already
 * required. Bun only lets a runtime plugin replace a file it hasn't loaded
 * yet, so this must run before the project's config is first evaluated; Alchemy's plugin factory, which every
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
      // Every resolution in the process passes here, so plain string tests.
      // The anchored entry test also lets the wrapper's own `?real` import of
      // the entry through.
      if (!resolved.url.startsWith("file:") || !ENTRY.test(resolved.url)) return resolved;
      // A file URL (not `data:`), so `require()` reaches the load hook too.
      return { url: resolved.url + WRAPPER_SUFFIX, format: "module", shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(WRAPPER_SUFFIX)) return nextLoad(url, context);
      const real = `${url.slice(0, -WRAPPER_SUFFIX.length)}?real`;
      return { format: "module", source: wrapper(real), shortCircuit: true };
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
