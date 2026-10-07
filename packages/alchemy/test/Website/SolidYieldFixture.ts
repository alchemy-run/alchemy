import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains, type ExpectUrlContainsOptions } from "../Cloudflare/Utils/Http.ts";

/**
 * The shared solid-yield app fixture. It is its own pnpm workspace package:
 * solid-yield runs on Solid 2, while `packages/alchemy` itself depends on
 * Solid 1 (SolidStart), so the fixture carries an isolated `node_modules`.
 */
export const solidYieldFixtureDir = pathe.resolve(import.meta.dirname, "fixtures/solid-yield-app");

/** Marker rendered into the built bundle by `src/app.tsx`. */
export const solidYieldAppMarker = "solid-yield-fixture";

/** Title of `index.html`, served for `/` and (with SPA fallback) deep links. */
export const solidYieldPageMarker = "SolidYield Fixture";

/** Memo scope restricted to the fixture sources. */
export const solidYieldMemoInclude = [
  "index.html",
  "src/**",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
];

// Vite's `vite:build-html` plugin expresses emitted asset paths relative to
// `cwd`, so clones live under the alchemy package.
const tempRoot = pathe.resolve(import.meta.dirname, "../../.tmp");

/**
 * Copy the fixture sources into a fresh temp directory and link the
 * fixture's installed `node_modules` into it, so `solid-js` resolves to the
 * fixture's Solid 2 rather than the alchemy package's Solid 1.
 */
export const cloneSolidYieldApp = Effect.fn(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = yield* cloneFixture(solidYieldFixtureDir, {
    prefix,
    tempRoot,
    entries: [".gitignore", "index.html", "package.json", "tsconfig.json", "vite.config.ts", "src"],
  });
  yield* fs.symlink(
    yield* fs.realPath(path.join(solidYieldFixtureDir, "node_modules")),
    path.join(rootDir, "node_modules"),
  );
  return rootDir;
});

/**
 * Assert a deployed build: `index.html` serves at `url` and the module
 * script it references is the compiled solid-yield app bundle.
 */
export const expectSolidYieldBuild = Effect.fn(function* (
  url: string,
  options: ExpectUrlContainsOptions = {},
) {
  const html = yield* expectUrlContains(`${url}/`, solidYieldPageMarker, options);
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (script === undefined) {
    return yield* Effect.die(new Error(`no module script in index.html: ${html.slice(0, 400)}`));
  }
  yield* expectUrlContains(new URL(script, `${url}/`).href, solidYieldAppMarker, {
    ...options,
    label: `${options.label ?? "solid-yield"} bundle`,
  });
});
