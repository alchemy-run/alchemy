/**
 * The git host, assembled from `alchemy/Git` building blocks — the
 * RFC's headline snippet, live.
 *
 * The package ships no Worker: `Git.Server` is a `Context.Service`
 * exposing the composed HTTP handler (git smart-HTTP wire + `/api/v1`
 * REST + `/api/v3` GitHub compat), and this file is the user-side
 * assembly — one layer graph, one `Effect.provide`, every block
 * swappable.
 */
import * as Git from "alchemy/Git";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The example's bucket — packs, clone bundles, and push spill. */
const GitObjects = Cloudflare.R2.Bucket("GitObjects");

// One layer graph, one Effect.provide. Every block is swappable — e.g.
// packs on S3 instead of R2 (`Git.BlobStoreS3`), or your own auth
// (implement `Git.Auth`: authenticate + authorize over domain actions)
// in place of the admin-key + scoped-repo-token default.
const GitLive = Git.ServerLive.pipe(
  Layer.provide(Git.ReposDurableObject), // refs + objects + pulls in DOs
  Layer.provide(Git.RegistryDurableObject), // owner/name → repoId
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs & bundles in R2
  Layer.provide(Git.AuthTokens), // admin key + scoped repo tokens
);

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "GitHost",
  {
    main: import.meta.url,
    ...Git.GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const git = yield* Git.Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(GitLive)),
) {}
