import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { PortlessNotInstalled, ProxyNodeUnavailable } from "../Errors.ts";
import { run } from "./Run.ts";

/**
 * The Node.js binary that runs Portless. Portless needs Node 24, and this
 * process may be Bun (the tests, and anyone who runs alchemy on Bun), so Bun
 * runs it through `node` on PATH; Node runs it with itself.
 */
export const node = Effect.gen(function* () {
  const command = typeof globalThis.Bun === "undefined" ? process.execPath : "node";
  const version = yield* run(ChildProcess.make(command, ["--version"])).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
  if (version === undefined || Number.parseInt(version.replace(/^v/, ""), 10) < 24) {
    return yield* new ProxyNodeUnavailable({ found: version });
  }
  return command;
});

/**
 * The path of Portless's CLI. Portless exports only its library entry, so its
 * `package.json` can't be resolved; the library entry's package is found by
 * walking up from it, and the CLI is that package's `bin`.
 */
export const portless = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* Effect.try({
    try: () => fileURLToPath(import.meta.resolve("portless")),
    catch: (cause) => new PortlessNotInstalled({ cause }),
  });
  let directory = path.dirname(entry);
  while (true) {
    const manifest = path.join(directory, "package.json");
    const text = yield* fs.readFileString(manifest).pipe(Effect.option);
    if (text._tag === "Some") {
      const json = yield* Effect.try({
        try: () =>
          JSON.parse(text.value) as { name?: string; bin?: string | Record<string, string> },
        catch: (cause) => new PortlessNotInstalled({ cause }),
      });
      if (json.name === "portless") {
        const bin = typeof json.bin === "string" ? json.bin : json.bin?.portless;
        if (bin === undefined) {
          return yield* new PortlessNotInstalled({ cause: `${manifest} declares no bin` });
        }
        return path.resolve(directory, bin);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return yield* new PortlessNotInstalled({ cause: `no portless package above ${entry}` });
    }
    directory = parent;
  }
});
