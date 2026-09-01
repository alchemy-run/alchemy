// @ts-check
// Node dev-mode hooks: run an alchemy checkout from source with no build.
//
// 1. A synchronous `resolve` hook (`module.registerHooks`) enables the
//    `bun` export condition for the monorepo's own packages (`alchemy`,
//    `@alchemy.run/*`, `@distilled.cloud/*`), whose exports map that
//    condition to `src/*.ts`. Under plain node the `import` condition
//    resolves built `lib/` output instead — requiring a `tsc -b` first,
//    and splitting the process across a src copy (the CLI) and a lib copy
//    (the user's stack, which imports `alchemy`) whenever lib is stale.
//    Packages without a `bun` condition (e.g. the published sigil) are
//    untouched — an enabled condition their exports never mention simply
//    doesn't match.
// 2. tsx's loader handles the actual `.ts`/`.tsx` loading — esbuild
//    transforms with tsx's own on-disk cache and source maps. Node's
//    built-in `--experimental-transform-types` covers plain `.ts` but not
//    JSX, and its wasm stripper re-runs uncached on every `node --watch`
//    restart (~7s for a full stack graph vs ~1s pre-built).
//
// Dev-only: the launcher (`bin/cli.js`) and the dev supervisor pass this
// via `--import` when spawning node in a checkout. Published installs run
// bundled `.js` and never load it (it is excluded from the tarball, and
// tsx is a devDependency).
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

/** @param {string} specifier */
const isMonorepoPackage = (specifier) =>
  specifier === "alchemy" ||
  specifier.startsWith("alchemy/") ||
  specifier.startsWith("@alchemy.run/") ||
  specifier.startsWith("@distilled.cloud/");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isMonorepoPackage(specifier)) return nextResolve(specifier, context);
    return nextResolve(specifier, {
      ...context,
      conditions: ["bun", ...context.conditions],
    });
  },
});

register({
  // Pin tsx to alchemy's tsconfig, not whatever happens to be in the
  // invoking project's cwd (tsx resolves its tsconfig from the working
  // directory). Running `alchemy dev` from an example would otherwise
  // transpile alchemy's own .tsx with that project's JSX settings — e.g.
  // classic-runtime `React.createElement` with no React import, or
  // `jsxImportSource: "solid-js"` — breaking the React files inside the
  // CLI. Same trade the bun launcher makes with `--tsconfig-override`.
  tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
});
