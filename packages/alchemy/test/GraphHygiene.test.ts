/**
 * Graph hygiene: the user-importable barrels must be parseable by ANY
 * bundler — Turbopack inside `next dev`/`next build`, OpenNext's esbuild
 * pass, the framework vite builds all compile site modules that import
 * these surfaces, and they must parse every module they can statically
 * reach.
 *
 * Host-only machinery (the local workerd runtime, vite, rolldown,
 * esbuild — everything that bottoms out in a native binary) is loaded
 * exclusively through `Util/hostImport.ts`, which is opaque to static
 * analysis. This suite walks the REAL static graph with esbuild's
 * resolver and fails on any reachable landmine — so a future engine
 * import that re-adds a static edge (including a LITERAL dynamic import,
 * which bundlers also resolve) breaks here instead of in a user's build.
 */
import { describe, expect, it } from "alchemy-test";
import * as esbuild from "esbuild";
import * as Effect from "effect/Effect";
import * as nodePath from "node:path";

/** Modules no user-compiled bundle may statically reach. */
const LANDMINES =
  /node_modules\/(workerd|esbuild|@esbuild|vite|rolldown|@rolldown|sharp|@img|tsx)\/|packages\/cloudflare-runtime\//;

const SRC = nodePath.resolve(import.meta.dirname, "..", "src");

/** The user-importable entry points (site modules import these). */
const BARRELS = [
  "index.ts",
  "Serve/index.ts",
  "Cloudflare/index.ts",
  "AWS/index.ts",
] as const;

const reachableLandmines = (entry: string) =>
  Effect.promise(async () => {
    const result = await esbuild.build({
      entryPoints: [nodePath.join(SRC, entry)],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      // Parse-safe pure-JS externals only — everything else must resolve
      // so the walk sees the true graph.
      external: ["effect", "@cloudflare/workers-types"],
    });
    return Object.keys(result.metafile.inputs).filter((p) =>
      LANDMINES.test(p),
    );
  });

describe.concurrent("graph hygiene (bundler-safety of public barrels)", () => {
  for (const barrel of BARRELS) {
    it.effect(`alchemy/${barrel.replace(/\/index\.ts$|\.ts$/, "")} reaches no host-only module`, () =>
      Effect.gen(function* () {
        const mines = yield* reachableLandmines(barrel);
        expect(
          mines,
          `static graph from ${barrel} reaches host-only modules — route the ` +
            `import through Util/hostImport.ts (literal dynamic imports are ` +
            `still static edges)`,
        ).toEqual([]);
      }),
    );
  }
});
