import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type { GetRepoError } from "./NamespaceTypes.ts";
import type { ReadNamespaceClient, ReadRepoClient } from "./ReadNamespace.ts";
import type { WriteNamespaceClient, WriteRepoClient } from "./WriteNamespace.ts";

/**
 * Bind a Cloudflare Artifacts namespace ({@link Namespace}) to a Worker and
 * obtain the full Effect-native {@link ReadWriteNamespaceClient}: every method
 * of the runtime `Artifacts` binding (`create` / `get` / `import` / `list` /
 * `delete`) and of the repository handle (`info` / `createToken` /
 * `listTokens` / `revokeToken` / `fork` / `log` / `readCommit` / `readTree` /
 * `readBlob` / `readFile`), each returning an Effect with typed errors.
 *
 * ### Using Artifacts inside a Worker
 * **Example:** Create, inspect and fork a repo
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Repos);
 * const created = yield* artifacts.create("starter-repo", {
 *   setDefaultBranch: "main",
 * });
 * const repo = yield* artifacts.get(created.name);
 * const info = yield* repo.info();
 * const fork = yield* repo.fork("starter-repo-copy");
 * ```
 *
 * **Example:** Handle a missing repo
 * ```typescript
 * const repo = yield* artifacts.get(name).pipe(
 *   Effect.catchTag("ArtifactsNotFound", () => Effect.succeed(undefined)),
 * );
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface ReadWriteNamespace extends Binding.Service<
  ReadWriteNamespace,
  "Cloudflare.Artifacts.ReadWriteNamespace",
  (namespace: Namespace) => Effect.Effect<ReadWriteNamespaceClient>
> {}

export const ReadWriteNamespace = Binding.Service<ReadWriteNamespace>(
  "Cloudflare.Artifacts.ReadWriteNamespace",
);

/** Full read + write handle to a single Artifacts repository. */
export interface RepoClient extends ReadRepoClient, WriteRepoClient {}

/** Full read + write client for a Cloudflare Artifacts namespace binding. */
export interface ReadWriteNamespaceClient
  extends Omit<ReadNamespaceClient, "get">, Omit<WriteNamespaceClient, "get"> {
  /** Open a full read + write handle to an existing repository. */
  get(name: string): Effect.Effect<RepoClient, GetRepoError, RuntimeContext>;
}
