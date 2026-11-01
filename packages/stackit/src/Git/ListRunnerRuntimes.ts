import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListRunnerRuntimesRequest extends Omit<
  git.ListRunnerRuntimesRequest,
  "projectId"
> {}

/**
 * Runtime binding for STACKIT Git `listRunnerRuntimes`: list the runtimes a runner offers, with the label a job's `runs-on` uses.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a
 * `Stackit.Git.Instance` or a `Stackit.ResourceManager.Project`, in a Function/Worker init phase
 * and provide {@link ListRunnerRuntimesHttp}. The project of the resource it binds to is injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.runner.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Listing Runtimes
 * **Example:** List the runtimes from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Forge = Stackit.Git.Instance("Forge", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listRunnerRuntimes = yield* Stackit.Git.ListRunnerRuntimes(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listRunnerRuntimes({});
 *         return yield* HttpServerResponse.json({ labels: items.map((runtime) => runtime.label) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListRunnerRuntimesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListRunnerRuntimes extends Binding.Service<
  ListRunnerRuntimes,
  "Stackit.Git.ListRunnerRuntimes",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListRunnerRuntimesRequest,
    ) => Effect.Effect<git.RunnerRuntimeList, git.ListRunnerRuntimesError, RuntimeContext>
  >
> {}

export const ListRunnerRuntimes = Binding.Service<ListRunnerRuntimes>(
  "Stackit.Git.ListRunnerRuntimes",
);
