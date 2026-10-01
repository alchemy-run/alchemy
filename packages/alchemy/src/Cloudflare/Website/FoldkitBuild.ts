import * as Schema from "effect/Schema";
import type { Plugin } from "vite";
import type { AssetsConfig } from "../Workers/Assets.ts";
import { BundleError } from "../../Bundle/Bundle.ts";

/** The versioned manifest returned by Foldkit's completed-build API. */
export const FoldkitBuildManifest = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  client: Schema.String,
  server: Schema.String,
  serverEntry: Schema.String,
  prerendered: Schema.Array(Schema.String),
});

export type FoldkitBuildManifest = typeof FoldkitBuildManifest.Type;

/** Validate the app's plugin result without loading a second Foldkit copy. */
export const FoldkitBuildMetadata = Schema.Struct({
  root: Schema.String,
  clientDirectory: Schema.String,
  serverDirectory: Schema.String,
  serverEntry: Schema.String,
  manifest: FoldkitBuildManifest,
});

export type FoldkitBuildMetadata = typeof FoldkitBuildMetadata.Type;

/** Prepare before building; call the reader only after buildApp succeeds. */
export const foldkitBuildMetadataReader = (
  plugins: ReadonlyArray<Pick<Plugin, "name" | "api">>,
  main: string | undefined,
): (() => FoldkitBuildMetadata) | undefined => {
  const plugin = plugins.find((plugin) => plugin.name === "foldkit:build");
  if (plugin === undefined) return undefined;
  if (main !== undefined) {
    throw new BundleError({
      message:
        "Foldkit ssr.build generates the Worker fetch handler and cannot be combined with main. Remove main or disable ssr.build for a custom Worker entry.",
    });
  }
  if (typeof plugin.api?.getBuildMetadata !== "function") {
    throw new BundleError({
      message:
        "Foldkit's build plugin does not expose getBuildMetadata(). Upgrade @foldkit/vite-plugin to 0.25.0 or newer.",
    });
  }
  return () =>
    Schema.decodeUnknownSync(FoldkitBuildMetadata)(
      plugin.api.getBuildMetadata(),
    );
};

/**
 * The asset routing a Foldkit build's manifest implies.
 *
 * A build with Foldkit metadata is server-rendered, and its client output
 * needs no routing of its own: a path the build prerendered is a file the
 * default `htmlHandling` serves, and the browser bundle's template is not
 * among the files, so `/` and every other unrendered path miss the asset
 * layer and reach the `fetch` handler, which carries the template and
 * renders into it. An asset-shaped miss is the handler's to classify, and
 * it answers with a 404 rather than a page.
 *
 * A build without the Foldkit build plugin is client-only: nothing renders outside
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
