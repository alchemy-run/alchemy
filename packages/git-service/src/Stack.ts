/**
 * The canonical deployable Stack for git-service (DESIGN.md §6).
 *
 * `GitStack` wires the whole service into one Alchemy Stack:
 *
 * - {@link GitWorker} — the stateless front door (REST + git wire),
 * - the `GitRepo` and `GitRegistry` Durable Objects (hosted by the
 *   Worker; their Live layers are provided on its init effect), and
 * - the shared `GitObjects` R2 bucket (referenced by the Repo DO's init,
 *   so it is provisioned transitively — nothing to list here).
 *
 * The deployer admin secret is resolved from the environment at deploy
 * time via `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")` inside the
 * Worker's init and bound as a secret binding.
 *
 * @section Deploying the service
 * @example alchemy.run.ts
 * ```typescript
 * import { GitStack } from "@alchemy.run/git-service/Stack";
 *
 * // GIT_SERVICE_ADMIN_TOKEN must be set in the deployer's environment.
 * export default GitStack();
 * ```
 *
 * @example Custom stack name
 * ```typescript
 * export default GitStack({ name: "MyGitService" });
 * ```
 *
 * @section Consuming the deployed stack
 * @example Test-harness deploy
 * ```typescript
 * const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
 *   providers: Cloudflare.providers(),
 *   state: Cloudflare.state(),
 * });
 * const stack = beforeAll(deploy(GitStack({ name: "GitServiceTest" })));
 * afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(GitStack({ name: "GitServiceTest" })));
 * ```
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import GitWorker from "./GitWorker.ts";

/** Options of {@link GitStack}. */
export interface GitStackOptions {
  /**
   * Stack name (also the state-store key of the deployment).
   * @default "GitService"
   */
  readonly name?: string | undefined;
}

/**
 * Builds the deployable git-service Stack: the {@link GitWorker} (which
 * transitively deploys the Repo/Registry DO namespaces and the R2 bucket)
 * with Cloudflare providers and state, returning the Worker's public URL
 * as the single typed stack output.
 */
export const GitStack = (options?: GitStackOptions) =>
  Alchemy.Stack(
    options?.name ?? "GitService",
    {
      providers: Cloudflare.providers(),
      state: Cloudflare.state(),
    },
    Effect.gen(function* () {
      const worker = yield* GitWorker;
      return {
        /** Public base URL of the deployed service (workers.dev). */
        url: worker.url.as<string>(),
      };
    }),
  );

export default GitStack();
