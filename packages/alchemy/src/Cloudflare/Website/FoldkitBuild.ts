import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { AssetsConfig } from "../Workers/Assets.ts";
import type {
  ViteBuildDirectories,
  ViteDerivedAssets,
} from "../Workers/Worker.ts";

/**
 * What a Foldkit build wrote beside its server bundle, as
 * `@foldkit/vite-plugin` writes it (`foldkit.build.json`). Decoded before
 * it is read: a manifest from a newer Foldkit with a shape this does not
 * know is a refusal, not a field silently read as `undefined`.
 */
export const FoldkitBuildManifest = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  /** Where the browser build was written, relative to the Vite root. */
  client: Schema.String,
  /** Where the server build was written, relative to the Vite root. */
  server: Schema.String,
  /** The server build's entry file, relative to `server`. */
  serverEntry: Schema.String,
  /** Every path the build generated a page for. */
  prerendered: Schema.Array(Schema.String),
  /** How to run the entry — always a Web `fetch` handler. */
  host: Schema.optional(Schema.Literals(["fetch"])),
});

export type FoldkitBuildManifest = typeof FoldkitBuildManifest.Type;

export const FOLDKIT_BUILD_MANIFEST = "foldkit.build.json";

/**
 * Reads the manifest a Foldkit build left in its server output directory.
 * A build with no server output, or one made by a Foldkit plugin that
 * writes no manifest, has none — that is a client-only app, and resolves
 * to `undefined`. A manifest that is present but unreadable stops the
 * deployment: routing derived from a guess would serve an empty page at
 * 200, which is the failure this file exists to rule out.
 */
export const readFoldkitBuildManifest = Effect.fn(function* (
  serverDirectory: string | undefined,
) {
  if (serverDirectory === undefined) {
    return undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(serverDirectory, FOLDKIT_BUILD_MANIFEST);
  if (!(yield* fs.exists(file))) {
    return undefined;
  }
  const raw = yield* fs.readFileString(file);
  // Neither failure below is one the deployment can recover from: the
  // manifest exists, so the build meant to describe itself, and a
  // description this cannot read must not become a guessed routing.
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new Error(`${file} is not valid JSON`, { cause }),
  }).pipe(Effect.catch((error) => Effect.die(error)));
  return yield* Schema.decodeUnknownEffect(FoldkitBuildManifest)(parsed).pipe(
    Effect.catch((error) =>
      Effect.die(
        new Error(
          `${file} does not describe a Foldkit build this version of Alchemy can deploy: ${String(error)}`,
        ),
      ),
    ),
  );
});

/**
 * The asset adjustments a Foldkit build's manifest implies.
 *
 * The asset layer answers a request before the Worker sees it, so what
 * it does with `index.html` decides whether a server-rendered front page
 * ever renders. The build emits that file either way — it is the shell
 * the browser bundle is injected into — but it is a page only when the
 * build prerendered `/`. Otherwise it is the unfilled template, and
 * leaving it out of the upload is what lets `/` reach the `fetch`
 * handler, which carries the same shell and renders into it. Every other
 * prerendered route is a file the default `htmlHandling` already serves,
 * and every miss reaches the handler, which answers an asset miss with
 * a 404 rather than a page.
 *
 * A build with no manifest is a client-only app: nothing renders outside
 * the browser, every route is the app's own to resolve, and a deep link
 * is a request for a file that does not exist. It gets the
 * single-page-application fallback, so the template is served and the
 * app's router takes over — the same default the other clouds' Foldkit
 * resources apply. A declaration still wins over it, so an app that ships
 * a real 404 page declares `"404-page"`.
 *
 * A declaration that asks for the single-page-application fallback on a
 * server-rendered build needs the template served, so it takes precedence
 * and nothing is derived.
 */
export const foldkitAssetsFromManifest = (
  manifest: FoldkitBuildManifest | undefined,
  declared: AssetsConfig | undefined,
): ViteDerivedAssets | undefined => {
  if (manifest === undefined) {
    return { notFoundHandling: "single-page-application" };
  }
  if (declared?.notFoundHandling === "single-page-application") {
    return undefined;
  }
  if (manifest.prerendered.includes("/")) {
    return undefined;
  }
  // Anchored to the directory root: an unanchored `index.html` would also
  // drop every prerendered `<route>/index.html`.
  return { ignore: ["/index.html"] };
};

/** {@link ViteOptions.deriveAssets} for a Foldkit build. */
export const deriveFoldkitAssets = (
  build: ViteBuildDirectories,
  declared: AssetsConfig | undefined,
): Effect.Effect<
  ViteDerivedAssets | undefined,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  readFoldkitBuildManifest(build.serverDirectory).pipe(
    Effect.map((manifest) => foldkitAssetsFromManifest(manifest, declared)),
  );
