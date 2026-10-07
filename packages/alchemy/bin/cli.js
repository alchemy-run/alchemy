#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import * as NodeModule from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathe";

NodeModule.enableCompileCache?.();

const binDir = path.dirname(import.meta.filename);
const entry = path.join(binDir, "alchemy.js");
const isDev = !(binDir.includes("/node_modules/") || binDir.includes("\\node_modules\\"));

// `bun run`/`bunx` start a node-shebang bin under Node but always point
// npm_execpath at bun. npm_config_user_agent only names the package-manager
// role (e.g. nub reports `bun/<v>` for a bun project while running Node).
const launchedByBun = path.basename(process.env.npm_execpath ?? "").startsWith("bun");

// Alchemy's own TSX carries `@jsxRuntime automatic` pragmas and sigil's
// jsx-dev-runtime is the production runtime, so Bun's startup JSX choice
// (from the caller's tsconfig and NODE_ENV) cannot break the CLI. NODE_ENV
// still names the mode for everything else.
process.env.NODE_ENV = "production";

if (typeof globalThis.Bun !== "undefined") {
  await import(pathToFileURL(entry).href);
} else if (launchedByBun) {
  // Started by bun as a package manager (`bun run`, `bunx`): run the CLI
  // under bun, as asked. `npm_execpath` is the bun binary itself.
  handOff(/** @type {string} */ (process.env.npm_execpath), [entry, ...process.argv.slice(2)]);
} else {
  // Oxc's loader needs complete module.registerHooks support (24.11.1+).
  // Keep this gate in sync with src/Util/Node.ts; the launcher must run
  // before TypeScript can be loaded.
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
  const supportsHooks =
    (major === 24 && (minor > 11 || (minor === 11 && patch >= 1))) || major >= 25;
  if (!supportsHooks) {
    process.stderr.write(
      `alchemy: node ${process.versions.node} is not supported. ` +
        "Upgrade to node 24.11.1 or newer.\n",
    );
    process.exit(1);
  }
  await import(new URL(isDev ? "register-dev-mode.js" : "register-oxc.js", import.meta.url).href);
  await import(pathToFileURL(entry).href);
}

/**
 * Replace this process with `program`: same pid, fds and process group, so
 * the terminal's signals and the exit status are the CLI's own. Windows has
 * no execve; there the CLI runs as a child sharing this terminal, with its
 * exit status forwarded.
 *
 * @param {string} program
 * @param {ReadonlyArray<string>} args
 */
function handOff(program, args) {
  try {
    if (process.platform !== "win32") process.execve(program, [program, ...args], process.env);
    const child = spawn(program, args, { stdio: "inherit" });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => process.exit(code ?? 1));
  } catch (error) {
    fail(error);
  }

  /** @param {unknown} error */
  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`alchemy: could not start ${program}: ${message}\n`);
    process.exit(1);
  }
}
