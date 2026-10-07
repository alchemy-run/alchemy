import type * as Effect from "effect/Effect";
import {
  mountGitRepository,
  type MountedRepository,
  type MountGitOptions,
} from "../FS/GitMount.ts";
import type { Repository, RepositoryCredentials } from "./Repository.ts";

export interface MountRepositoryOptions extends MountGitOptions {
  /**
   * The HTTP Basic credential your Git host's auth middleware accepts.
   * Authenticates the build-time checkout of a private repository and, with
   * `access: "read"` or `"write"`, git inside the container (bound into its
   * environment, never baked into the image).
   */
  readonly credentials?: RepositoryCredentials;
}

/**
 * Check out a repository from an Alchemy Git service at an absolute path in
 * the container (or other image host) it is yielded in.
 *
 * The checkout is baked into the image with its full `.git`, on the
 * requested `ref` as a local branch tracking `origin`. `access` decides what
 * git may do inside the container: `"none"` (a snapshot, push disabled),
 * `"read"` (fetch and pull), or `"write"` (also push).
 *
 * ### Mounting a repository
 * **Example:** A writable checkout from your own Git service
 * ```typescript
 * export const Docs = Git.Repository("docs", { url: GitHost.url, owner: "acme", credentials });
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", image: "node:22-bookworm" },
 *   Effect.gen(function* () {
 *     const docs = yield* Git.MountRepository(yield* Docs, {
 *       path: "/workspace/docs",
 *       access: "write",
 *       credentials,
 *     });
 *     // ...
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Repository
 * @category Git
 */
export const MountRepository = (
  repository: Repository,
  options: MountRepositoryOptions,
): Effect.Effect<MountedRepository> => {
  const credentials = options.credentials
    ? { username: options.credentials.username ?? "git", password: options.credentials.password }
    : undefined;
  return mountGitRepository({
    kind: "Git.MountRepository",
    resource: repository,
    url: repository.cloneUrl,
    ...(credentials ? { credentials, runtimeCredentials: credentials } : {}),
    mount: options,
  });
};
