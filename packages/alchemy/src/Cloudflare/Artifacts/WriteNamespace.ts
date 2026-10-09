import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type {
  CreateOptions,
  CreateRepoError,
  CreateRepoResult,
  CreateTokenError,
  CreateTokenResult,
  DeleteRepoError,
  ForkOptions,
  ForkRepoError,
  GetRepoError,
  ImportOptions,
  ImportRepoError,
  NativeArtifacts,
  NativeArtifactsRepo,
  RevokeTokenError,
  TokenScope,
} from "./NamespaceTypes.ts";

/**
 * Bind an Artifacts {@link Namespace} to a Worker with write access and obtain
 * the Effect-native {@link WriteNamespaceClient}: `create`, `import`,
 * `delete`, and `get` (a repo handle with `createToken` / `revokeToken` /
 * `fork`).
 *
 * **Example:** Create a repo and mint a short-lived read token
 * ```typescript
 * const repos = yield* Cloudflare.Artifacts.WriteNamespace(Repos);
 * const created = yield* repos.create("starter-repo", { setDefaultBranch: "main" });
 * const repo = yield* repos.get(created.name);
 * const token = yield* repo.createToken("read", 3600);
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Cloudflare.Artifacts.WriteNamespace",
  (namespace: Namespace) => Effect.Effect<WriteNamespaceClient>
> {}

export const WriteNamespace = Binding.Service<WriteNamespace>(
  "Cloudflare.Artifacts.WriteNamespace",
);

/** Write-side, Effect-native handle to a single Artifacts repository. */
export interface WriteRepoClient {
  /** Repository name the handle was opened with. */
  readonly name: string;
  /** Underlying runtime repository capability (an RPC stub). */
  readonly raw: NativeArtifactsRepo;
  /**
   * Mint a git access token. `scope` defaults to `"write"`; `ttl` is in
   * seconds (default 86400, 60–31536000).
   */
  createToken(
    scope?: TokenScope,
    ttl?: number,
  ): Effect.Effect<CreateTokenResult, CreateTokenError, RuntimeContext>;
  /** Revoke a token by plaintext or ID. `true` if revoked, `false` if not found. */
  revokeToken(tokenOrId: string): Effect.Effect<boolean, RevokeTokenError, RuntimeContext>;
  /** Fork this repository into a new repository in the same namespace. */
  fork(
    name: string,
    opts?: ForkOptions,
  ): Effect.Effect<CreateRepoResult, ForkRepoError, RuntimeContext>;
  /** Release the runtime capability before the request ends. */
  dispose(): Effect.Effect<void, never, RuntimeContext>;
}

/** Write client surface for an Artifacts namespace binding. */
export interface WriteNamespaceClient {
  /** Effect resolving to the raw runtime binding. */
  raw: Effect.Effect<NativeArtifacts, never, RuntimeContext>;
  /** Create a repository; the result carries the remote and an initial write token. */
  create(
    name: string,
    opts?: CreateOptions,
  ): Effect.Effect<CreateRepoResult, CreateRepoError, RuntimeContext>;
  /** Import a public HTTPS git remote into a new repository. */
  import(opts: ImportOptions): Effect.Effect<CreateRepoResult, ImportRepoError, RuntimeContext>;
  /** Delete a repository and its tokens. `true` if deleted, `false` if not found. */
  delete(name: string): Effect.Effect<boolean, DeleteRepoError, RuntimeContext>;
  /** Open a handle to an existing repository (to mint tokens or fork). */
  get(name: string): Effect.Effect<WriteRepoClient, GetRepoError, RuntimeContext>;
}
