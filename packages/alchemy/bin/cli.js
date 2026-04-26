#!/usr/bin/env node
// alchemy CLI launcher
//
// Resolves the alchemy CLI entrypoint via node module resolution and execs it
// under whichever runtime the user invoked us with. The shebang forces this
// launcher to run as node even when bun was the invoker, but bun forwards
// signals about itself via env vars on every child it spawns:
//
//   - `npm_execpath`           → path to bun (set for `bun run <script>`)
//   - `npm_config_user_agent`  → "bun/<version> ..." (set for `bun run`,
//                                `bunx`, and direct bun-launched bins)
//
// Either signal is enough to know bun is the outer runtime.
//
// Dev vs published: when this launcher runs out of an alchemy checkout
// (i.e. *not* from inside a `node_modules/` tree) and bun is available, we
// run the .ts source directly so dev iteration is edit → reload, no rebuild.
// The published tarball ships the .ts files as well (alchemy's `bun`/`worker`
// exports point at .ts source), but consumers install into `node_modules/`,
// so the path check sends them to the bundled `alchemy.js` regardless.
//
// foreground-child forwards stdio + signals and exits with the child's code,
// so the launcher is transparent to the invoking shell / npm script.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "pathe";
import { foregroundChild } from "foreground-child";

const require = createRequire(import.meta.url);

const execpath = (process.env.npm_execpath ?? "").toLowerCase();
const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
const invokedByBun = execpath.includes("bun") || userAgent.startsWith("bun/");

const jsEntry = require.resolve("alchemy/bin/alchemy.js");
const binDir = path.dirname(jsEntry);
const tsEntry = path.join(binDir, "alchemy.ts");

// Treat any install-tree path as published; only a raw checkout uses .ts.
const useTs = !(
  jsEntry.includes("/node_modules/") || jsEntry.includes("\\node_modules\\")
);

// .ts only runs under bun. Force bun in dev even if node was the invoker.
const runtime = useTs || invokedByBun ? "bun" : "node";

const args = [];

if (runtime === "bun" && useTs) {
  // Pin bun's tsconfig to alchemy's, not whatever happens to be in the
  // invoking workspace's cwd. Bun's default is `$cwd/tsconfig.json`, which
  // means invoking `alchemy` from e.g. `examples/cloudflare-solidstart`
  // would transpile alchemy's own .tsx files with that example's JSX
  // settings (jsx: "preserve", jsxImportSource: "solid-js"), breaking the
  // React files inside the alchemy CLI.
  args.push(`--tsconfig-override=${path.join(binDir, "..", "tsconfig.json")}`);
}

args.push(useTs ? tsEntry : jsEntry, ...process.argv.slice(2));

foregroundChild(runtime, args);
