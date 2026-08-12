/**
 * The git-service construct (DESIGN.md §6).
 *
 * git-service is distributed as a **function returning an Effect** that you
 * instantiate inside your own `Alchemy.Stack` — the package does not ship a
 * Stack of its own, so providers, state store, stack name, and any sibling
 * resources stay under your control.
 *
 * Yielding {@link GitService} deploys the {@link GitWorker} front door and,
 * transitively, everything it hosts: the `GitRepo` and `GitRegistry`
 * Durable Object namespaces and the shared `GitObjects` R2 bucket.
 *
 * The deployer admin secret is resolved from the environment at deploy time
 * via `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")` inside the Worker's init
 * and bound as a secret binding.
 *
 * @section Deploying the service
 * @example Instantiate inside your own Stack
 * ```typescript
 * import { GitService } from "@alchemy.run/git";
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * // GIT_SERVICE_ADMIN_TOKEN must be set in the deployer's environment.
 * export default Alchemy.Stack(
 *   "MyGitService",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const git = yield* GitService();
 *     return { url: git.url };
 *   }),
 * );
 * ```
 *
 * @example Compose with your own resources
 * ```typescript
 * Effect.gen(function* () {
 *   const git = yield* GitService();
 *   const site = yield* MyWebsite; // anything else in the same Stack
 *   return { gitUrl: git.url, siteUrl: site.url };
 * });
 * ```
 */
import * as Effect from "effect/Effect";
import GitWorker from "./GitWorker.ts";

/**
 * Options of {@link GitService}. Reserved for future parametrization
 * (bucket override, worker name, admin-key config key).
 */
export interface GitServiceOptions {}

/**
 * Instantiates the git service inside the caller's Stack effect: deploys
 * the {@link GitWorker} (REST management plane + git smart-HTTP wire
 * plane, hosting both Durable Object namespaces and the shared R2 bucket)
 * and returns a handle with the Worker and its public URL output.
 */
export const GitService = (_options?: GitServiceOptions) =>
  Effect.gen(function* () {
    const worker = yield* GitWorker;
    return {
      /** The deployed front-door Worker. */
      worker,
      /** Public base URL of the deployed service (workers.dev). */
      url: worker.url.as<string>(),
    };
  });
