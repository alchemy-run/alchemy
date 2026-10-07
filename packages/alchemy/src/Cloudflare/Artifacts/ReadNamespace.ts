import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type {
  CommitMetadata,
  GetRepoError,
  ListOptions,
  ListReposError,
  ListTokensError,
  LogOptions,
  NativeArtifacts,
  NativeArtifactsRepo,
  ReadBytesError,
  ReadFileOptions,
  ReadObjectError,
  RepoInfo,
  RepoInfoError,
  RepoListItem,
  RepoListResult,
  TokenListResult,
  TreeEntry,
} from "./NamespaceTypes.ts";

/**
 * Bind an Artifacts {@link Namespace} to a Worker with read access and obtain
 * the Effect-native {@link ReadNamespaceClient}: `get` (a read-only repo
 * handle with `info` / `log` / `readCommit` / `readTree` / `readBlob` /
 * `readFile` / `listTokens`), `list` and `listAll`.
 *
 * **Example:** Read a file from a repo inside a Worker
 * ```typescript
 * const repos = yield* Cloudflare.Artifacts.ReadNamespace(Repos);
 * const repo = yield* repos.get("starter-repo");
 * const readme = yield* repo.readFile({ ref: "main", path: "README.md" });
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface ReadNamespace extends Binding.Service<
  ReadNamespace,
  "Cloudflare.Artifacts.ReadNamespace",
  (namespace: Namespace) => Effect.Effect<ReadNamespaceClient>
> {}

export const ReadNamespace = Binding.Service<ReadNamespace>("Cloudflare.Artifacts.ReadNamespace");

/**
 * Read-only, Effect-native handle to a single Artifacts repository (wraps the
 * runtime's repository capability).
 */
export interface ReadRepoClient {
  /** Repository name the handle was opened with. */
  readonly name: string;
  /** Underlying runtime repository capability (an RPC stub). */
  readonly raw: NativeArtifactsRepo;
  /** Fresh repository metadata lookup (includes the git `remote`). */
  info(): Effect.Effect<RepoInfo, RepoInfoError, RuntimeContext>;
  /** List the repository's access tokens (metadata only, no plaintext). */
  listTokens(): Effect.Effect<TokenListResult, ListTokensError, RuntimeContext>;
  /** Commits along the first-parent chain, newest first (empty if the ref is unknown). */
  log(opts?: LogOptions): Effect.Effect<CommitMetadata[], ReadObjectError, RuntimeContext>;
  /** Decode a commit by SHA-1, or `null` if missing. */
  readCommit(hash: string): Effect.Effect<CommitMetadata | null, ReadObjectError, RuntimeContext>;
  /** Immediate children of a tree by SHA-1, or `null` if missing. */
  readTree(hash: string): Effect.Effect<TreeEntry[] | null, ReadObjectError, RuntimeContext>;
  /** Raw bytes of a blob by SHA-1 (untyped `Blob`), or `null` if missing. */
  readBlob(hash: string): Effect.Effect<Blob | null, ReadBytesError, RuntimeContext>;
  /** Resolve a file at a ref (MIME-typed `Blob`), or `null` if missing / a directory. */
  readFile(args: ReadFileOptions): Effect.Effect<Blob | null, ReadBytesError, RuntimeContext>;
  /** Release the runtime capability before the request ends. */
  dispose(): Effect.Effect<void, never, RuntimeContext>;
}

/** Read-only client surface for an Artifacts namespace binding. */
export interface ReadNamespaceClient {
  /** Effect resolving to the raw runtime binding. */
  raw: Effect.Effect<NativeArtifacts, never, RuntimeContext>;
  /**
   * Open a handle to an existing repository. Fails with `ArtifactsNotFound`
   * if it does not exist, or `Artifacts{Import,Fork,Create}InProgress` if it
   * is not ready yet.
   */
  get(name: string): Effect.Effect<ReadRepoClient, GetRepoError, RuntimeContext>;
  /** One page of repositories (cursor-paginated). */
  list(opts?: ListOptions): Effect.Effect<RepoListResult, ListReposError, RuntimeContext>;
  /** Every repository in the namespace, following `cursor` across pages. */
  listAll(opts?: { limit?: number }): Stream.Stream<RepoListItem, ListReposError, RuntimeContext>;
}
