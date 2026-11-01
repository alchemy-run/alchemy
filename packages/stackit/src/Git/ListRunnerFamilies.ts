import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListRunnerFamiliesRequest extends Omit<
  git.ListRunnerFamiliesRequest,
  "projectId"
> {}

/**
 * Runtime binding for STACKIT Git `listRunnerFamilies`: list the job families a runner can use, with their CPU, memory and disk limits.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a
 * `Stackit.Git.Instance` or a `Stackit.ResourceManager.Project`, in a Function/Worker init phase
 * and provide {@link ListRunnerFamiliesHttp}. The project of the resource it binds to is injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.runner.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Listing Families
 * **Example:** List the families from a Cloudflare Worker
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
 *     const listRunnerFamilies = yield* Stackit.Git.ListRunnerFamilies(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listRunnerFamilies({});
 *         return yield* HttpServerResponse.json({ names: items.map((family) => family.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListRunnerFamiliesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListRunnerFamilies extends Binding.Service<
  ListRunnerFamilies,
  "Stackit.Git.ListRunnerFamilies",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListRunnerFamiliesRequest,
    ) => Effect.Effect<git.RunnerFamilyList, git.ListRunnerFamiliesError, RuntimeContext>
  >
> {}

export const ListRunnerFamilies = Binding.Service<ListRunnerFamilies>(
  "Stackit.Git.ListRunnerFamilies",
);
