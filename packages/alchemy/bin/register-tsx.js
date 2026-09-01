// @ts-check
// Node loader hook for alchemy's .tsx source.
//
// Node's type stripping (`--experimental-transform-types`) deliberately does
// not support JSX, so running the CLI from source under node dies on the
// first .tsx module (the CliKit terminal runtime) with
// ERR_UNKNOWN_FILE_EXTENSION. This registers a synchronous in-thread `load`
// hook that transpiles ONLY `.tsx` files with oxc (via rolldown, already a
// runtime dependency); plain `.ts` keeps flowing through node's built-in
// type stripping untouched.
//
// Dev-only: the launcher (`bin/cli.js`) and the dev supervisor pass this via
// `--import` when spawning node against `.ts` entrypoints in a checkout.
// Published installs run bundled `.js` and never load it.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";

registerHooks({
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
