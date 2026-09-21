import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { AssetsConfig } from "../Workers/Assets.ts";
import { BundleError } from "../../Bundle/Bundle.ts";

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
});

export type FoldkitBuildManifest = typeof FoldkitBuildManifest.Type;

export const FOLDKIT_BUILD_MANIFEST = "foldkit.build.json";

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FoldkitBuildManifest),
);

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
  // Not a failure the deployment can recover from: the manifest exists, so
  // the build meant to describe itself, and a description this cannot read
  // must not become a guessed routing.
  return yield* decodeManifest(raw).pipe(
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
 * The asset routing a Foldkit build's manifest implies.
 *
 * A build that wrote a manifest is server-rendered, and its client output
 * needs no routing of its own: a path the build prerendered is a file the
 * default `htmlHandling` serves, and the browser bundle's template is not
 * among the files, so `/` and every other unrendered path miss the asset
 * layer and reach the `fetch` handler, which carries the template and
 * renders into it. An asset-shaped miss is the handler's to classify, and
 * it answers with a 404 rather than a page.
 *
 * A build with no manifest is a client-only app: nothing renders outside
 * the browser, every route is the app's own to resolve, and a deep link
 * is a request for a file that does not exist. It gets the
 * single-page-application fallback, so the template is served and the
 * app's router takes over — the same default the other clouds' Foldkit
 * resources apply. A declaration still wins over it, so an app that ships
 * a real 404 page declares `"404-page"`.
 */
export const foldkitAssetsFromManifest = (
  manifest: FoldkitBuildManifest | undefined,
): AssetsConfig | undefined =>
  manifest === undefined
    ? { notFoundHandling: "single-page-application" }
    : undefined;

/** Read Foldkit's build contract before the shared Vite source hashes assets. */
export const deriveFoldkitAssets = Effect.fn(function* (
  serverDirectory: string | undefined,
  main: string | undefined,
) {
  const manifest = yield* readFoldkitBuildManifest(serverDirectory);
  if (manifest !== undefined && main !== undefined) {
    return yield* Effect.fail(
      new BundleError({
        message:
          "Foldkit ssr.build generates the Worker fetch handler and cannot be combined with main. Remove main or disable ssr.build for a custom Worker entry.",
      }),
    );
  }
  return foldkitAssetsFromManifest(manifest);
});
