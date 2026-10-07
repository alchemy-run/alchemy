import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { mountGitRepository, type MountGitOptions } from "../../FS/GitMount.ts";
import * as Output from "../../Output.ts";
import { tokenSecret } from "./GitCredential.ts";
import type { Repository } from "./Repository.ts";
import { RepositoryToken } from "./RepositoryToken.ts";

export interface MountRepositoryOptions extends MountGitOptions {
  /**
   * Lifetime of the repository token the mount mints, in seconds. The
   * token authenticates the build-time checkout and, with `access: "read"`
   * or `"write"`, git inside the container. An expired token is re-minted
   * on the next deploy.
   * @default 31536000 (one year, the maximum)
   */
  readonly tokenTtl?: number;
}

/**
 * Check out a Cloudflare Artifacts repository at an absolute path in the
 * container (or other image host) it is yielded in.
 *
 * The mount mints its own {@link RepositoryToken} — `write` scope for
 * `access: "write"`, `read` otherwise — so there are no credentials to pass.
 * The checkout is baked into the image with its full `.git`, on the
 * requested `ref` as a local branch tracking `origin`. `access` decides what
 * git may do inside the container: `"none"` (a snapshot, push disabled),
 * `"read"` (fetch and pull), or `"write"` (also push).
 *
 * ### Mounting a repository
 * **Example:** A writable Artifacts repository for a coding agent
 * ```typescript
 * export const Scratch = Cloudflare.Artifacts.Repository("Scratch", {
 *   namespace: "agents",
 *   import: { url: "https://github.com/acme/app.git" },
 * });
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", image: "node:22-bookworm" },
 *   Effect.gen(function* () {
 *     const repo = yield* Cloudflare.Artifacts.MountRepository(yield* Scratch, {
 *       path: "/workspace/scratch",
 *       access: "write",
 *     });
 *     // ...
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Artifacts
 */
export const MountRepository = (repository: Repository, options: MountRepositoryOptions) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return yield* mountGitRepository({
        kind: "Cloudflare.Artifacts.MountRepository",
        url: repository.remote,
        mount: options,
      });
    }
    const token = yield* RepositoryToken(`${repository.LogicalId}-mount-${options.path}`, {
      repository,
      scope: options.access === "write" ? "write" : "read",
      ttl: options.tokenTtl ?? 31_536_000,
    });
    // Basic auth: any username, the token without its `?expires=` suffix.
    const credentials = {
      username: "x",
      password: token.token.pipe(Output.map((value) => Redacted.make(tokenSecret(value)))),
    };
    return yield* mountGitRepository({
      kind: "Cloudflare.Artifacts.MountRepository",
      resource: repository,
      url: repository.remote,
      credentials,
      runtimeCredentials: credentials,
      mount: options,
    });
  });
