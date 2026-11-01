import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListInstancesRequest extends Omit<git.ListInstancesRequest, "projectId"> {}

/**
 * Runtime binding for STACKIT Git `listInstances`: list the Git instances in the project.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a
 * `Stackit.Git.Instance` or a `Stackit.ResourceManager.Project`, in a Function/Worker init phase
 * and provide {@link ListInstancesHttp}. The project of the resource it binds to is injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.list`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Listing Instances
 * **Example:** List the project's instances from a Cloudflare Worker
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
 *     const listInstances = yield* Stackit.Git.ListInstances(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instances } = yield* listInstances({});
 *         return yield* HttpServerResponse.json({ urls: instances.map((instance) => instance.url) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.Git.ListInstances",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListInstancesRequest,
    ) => Effect.Effect<git.InstanceList, git.ListInstancesError, RuntimeContext>
  >
> {}

export const ListInstances = Binding.Service<ListInstances>("Stackit.Git.ListInstances");
