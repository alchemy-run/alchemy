import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type * as Artifacts from "./Store.ts";

/**
 * Bind a Cloudflare Artifacts namespace ({@link Store}) to a Worker and obtain
 * the Effect-native {@link ReadWriteStoreClient} (read + write: create / list / get /
 * delete / import).
 *
 * `ReadWriteStore` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.Artifacts.ReadWriteStore(Repos)`.
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 * @example Using Artifacts inside a Worker
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadWriteStore(Repos);
 * const repo = yield* artifacts.create("starter-repo", {
 *   setDefaultBranch: "main",
 * });
 * ```
 */
export interface ReadWriteStore extends Binding.Service<
  ReadWriteStore,
  "Cloudflare.Artifacts.ReadWriteStore",
  (artifacts: Artifacts.Store) => Effect.Effect<ReadWriteStoreClient>
> {}

export const ReadWriteStore = Binding.Service<ReadWriteStore>(
  "Cloudflare.Artifacts.ReadWriteStore",
);

export class ArtifactsError extends Data.TaggedError("ArtifactsError")<{
  message: string;
  cause: Error;
}> {}

export type Scope = "read" | "write";

export type CreateOptions = {
  readOnly?: boolean;
  description?: string;
  setDefaultBranch?: string;
};

export type ImportOptions = {
  source: { url: string; branch?: string; depth?: number };
  target: {
    name: string;
    opts?: { description?: string; readOnly?: boolean };
  };
};

export type ListOptions = {
  limit?: number;
  cursor?: string;
};

export type ForkOptions = {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
};

/**
 * Effect-native handle to a single Artifacts repo. Wraps the runtime
 * {@link ArtifactsRepo} so each method returns an Effect.
 */
export interface RepoClient {
  /** Underlying Cloudflare runtime handle. */
  raw: ArtifactsRepo;
  createToken(
    scope?: Scope,
    ttl?: number,
  ): Effect.Effect<ArtifactsCreateTokenResult, ArtifactsError>;
  listTokens(): Effect.Effect<ArtifactsTokenListResult, ArtifactsError>;
  revokeToken(tokenOrId: string): Effect.Effect<boolean, ArtifactsError>;
  fork(
    name: string,
    opts?: ForkOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError>;
}

/**
 * Read-only client surface for an Artifacts namespace binding (look up + list).
 */
export interface ReadStoreClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<Artifacts, never, RuntimeContext>;
  /** Look up an existing repo by name. Fails with `ArtifactsError` if missing. */
  get(name: string): Effect.Effect<RepoClient, ArtifactsError, RuntimeContext>;
  list(
    opts?: ListOptions,
  ): Effect.Effect<ArtifactsRepoListResult, ArtifactsError, RuntimeContext>;
}

/**
 * Write client surface for an Artifacts namespace binding (create / delete / import).
 */
export interface WriteStoreClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<Artifacts, never, RuntimeContext>;
  create(
    name: string,
    opts?: CreateOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
  delete(name: string): Effect.Effect<boolean, ArtifactsError, RuntimeContext>;
  import(
    opts: ImportOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
}

/**
 * Full read + write client for a Cloudflare Artifacts namespace binding.
 */
export interface ReadWriteStoreClient
  extends ReadStoreClient, WriteStoreClient {}

/**
 * Bind a Cloudflare Artifacts namespace with read-only access
 * (`Cloudflare.Artifacts.ReadStore(Repos)`): `get` / `list` / `raw`.
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface ReadStore extends Binding.Service<
  ReadStore,
  "Cloudflare.Artifacts.ReadStore",
  (artifacts: Artifacts.Store) => Effect.Effect<ReadStoreClient>
> {}
export const ReadStore = Binding.Service<ReadStore>(
  "Cloudflare.Artifacts.ReadStore",
);

/**
 * Bind a Cloudflare Artifacts namespace with write access
 * (`Cloudflare.Artifacts.WriteStore(Repos)`): `create` / `delete` / `import`.
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface WriteStore extends Binding.Service<
  WriteStore,
  "Cloudflare.Artifacts.WriteStore",
  (artifacts: Artifacts.Store) => Effect.Effect<WriteStoreClient>
> {}
export const WriteStore = Binding.Service<WriteStore>(
  "Cloudflare.Artifacts.WriteStore",
);
