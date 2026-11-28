import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

/** What `git` needs to reach a repository. */
export interface GitRemote {
  /** The remote's URL: `git clone <url>`, `git push <url> HEAD:main`. */
  readonly url: string;
  /**
   * Environment for the `git` process. It carries the remote's credential as
   * an `http.extraHeader`, so nothing is written to a config file or a URL.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface PushRepositoryClient {
  /** The repository as a git remote this host may clone, fetch and push. */
  readonly remote: Effect.Effect<GitRemote, never, RuntimeContext>;
}

/**
 * Clone, fetch and push a repository with the `git` CLI.
 *
 * In a sandbox with a gateway, the remote is the gateway: it forwards git's
 * requests to GitHub with the token, which never enters the sandbox.
 *
 * ### Pushing from a program
 * **Example:** Clone, commit and push
 * ```typescript
 * const repo = yield* GitHub.PushRepository(MyRepo);
 * // in fetch:
 * const { url, env } = yield* repo.remote;
 * yield* ChildProcess.make("git", ["clone", url, "work"], { env, extendEnv: true }).pipe(
 *   ChildProcess.exitCode,
 * );
 * ```
 *
 * @binding
 * @product Repository
 */
export interface PushRepository extends Binding.Service<
  PushRepository,
  "GitHub.PushRepository",
  (repo: Repository) => Effect.Effect<PushRepositoryClient>
> {}

export const PushRepository = Binding.Service<PushRepository>("GitHub.PushRepository");
