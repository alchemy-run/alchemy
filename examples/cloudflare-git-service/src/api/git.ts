/** The application's HTTP routes: our API and Git, with shared authentication. */
import * as Http from "alchemy/Http";

import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Layer from "effect/Layer";
import { AppApiLive } from "./api.ts";
import { Authentication } from "./middleware.ts";

/** Packs, clone bundles, and spilled pushes. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // `bun test` sets NODE_ENV=test: the integration test tears the stack
  // down with repositories still in the bucket.
  forceDestroy: process.env.NODE_ENV === "test",
});

const PublicRoutes = Layer.mergeAll(AppApiLive, Git.ApiLive).pipe(
  Layer.provide(Authentication.layer),
);

export const HttpLive = Layer.mergeAll(PublicRoutes, Git.InternalApiLive).pipe(
  Layer.provide(Git.HandlersLive),
  Layer.provide(Git.ReposDurableObject),
  Layer.provide(Git.RegistryDurableObject), // owner/name → repo
  Layer.provide(Git.HasherInline), // push verification in this Worker
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs, bundles, large pushes
  Layer.provide(Http.Platform),
);
