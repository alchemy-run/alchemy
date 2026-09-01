// @ts-check
// Node dev-mode hooks: run an alchemy checkout from source with no build.
//
// Two synchronous in-thread module hooks (`module.registerHooks`):
//
// 1. `resolve` — enables the `bun` export condition for the monorepo's own
//    packages (`alchemy`, `@alchemy.run/*`, `@distilled.cloud/*`), whose
//    exports map that condition to `src/*.ts`. Under plain node the
//    `import` condition resolves built `lib/` output instead — requiring a
//    `tsc -b` first, and splitting the process across a src copy (the CLI)
//    and a lib copy (the user's stack, which imports `alchemy`) whenever
//    lib is stale. Packages without a `bun` condition (e.g. the published
//    sigil) are untouched — an enabled condition their exports never
//    mention simply doesn't match.
// 2. `load` — transpiles `.tsx` with oxc (via rolldown, already a runtime
//    dependency); node's own `--experimental-transform-types` handles
//    plain `.ts` but deliberately not JSX.
//
// Dev-only: the launcher (`bin/cli.js`) and the dev supervisor pass this
// via `--import` when spawning node in a checkout. Published installs run
// bundled `.js` and never load it (it is excluded from the tarball).
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";

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
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".tsx")) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(url);
    const result = transformSync(filename, readFileSync(filename, "utf8"), {
      lang: "tsx",
      // Matches the workspace tsconfig (`jsx: "react-jsx"`). Per-file
      // `@jsxImportSource` pragmas still take precedence over this default.
      jsx: { runtime: "automatic", importSource: "react" },
      sourcemap: true,
    });
    if (result.errors.length > 0) {
      throw new Error(
        `Failed to transform ${filename}:\n${result.errors
          .map((error) => error.message)
          .join("\n")}`,
      );
    }
    let source = result.code;
    if (result.map) {
      const map = Buffer.from(JSON.stringify(result.map)).toString("base64");
      source += `\n//# sourceMappingURL=data:application/json;base64,${map}`;
    }
    return { format: "module", source, shortCircuit: true };
  },
});
