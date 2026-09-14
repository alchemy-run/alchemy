/**
 * The git server, assembled from `alchemy/Git` blocks. Each line is a
 * decision with its own implementations; the Repo DO needs the three
 * below it.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Layer from "effect/Layer";
import { AppApi } from "./api.ts";
import { AuthenticatedLive } from "./middleware.ts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Session, Unauthorized } from "./auth.ts";

/** Packs, clone bundles, and spilled pushes. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // `bun test` sets NODE_ENV=test: the integration test tears the stack
  // down with repositories still in the bucket.
  forceDestroy: process.env.NODE_ENV === "test",
});

const MeLive = HttpApiBuilder.group(AppApi, "app", (h) =>
  h.handle("me", () =>
    Effect.gen(function* () {
      const { user } = yield* Session;
      if (user === null) return yield* new Unauthorized();
      return user;
    }),
  ),
);

export const GitLive = Git.Server.layer(AppApi, MeLive).pipe(
  Layer.provide(Git.HandlersLive),
  Layer.provide(AuthenticatedLive),
  Layer.provide(Git.ReposDurableObject),
  Layer.provide(Git.RegistryDurableObject), // owner/name → repo
  Layer.provide(Git.HasherInline), // push verification in this Worker
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs, bundles, large pushes
);
