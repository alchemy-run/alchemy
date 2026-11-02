import type * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListPoliciesRequest extends Omit<
  serverUpdate.ListUpdatePoliciesRequest,
  "projectId"
> {}

/**
 * Runtime binding for Server Update `listUpdatePolicies`: list the update policies a
 * project can use, whose ids `Stackit.ServerUpdate.Enablement` takes.
 *
 * Bind this operation to any resource in that project (a {@link BindingScope}) in a
 * Function/Worker init phase and provide {@link ListPoliciesHttp}. Its project is
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-update.policy.list` on the project of the
 * bound resource, so it reaches that whole project: STACKIT binds roles on projects,
 * folders and organizations, not on a single server. The deployer needs `iam.role.add`
 * on that scope to define the role.
 *
 * ### Listing Policies
 * **Example:** List the project's update policies
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Network = Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listPolicies = yield* Stackit.ServerUpdate.ListPolicies(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listPolicies();
 *         return yield* HttpServerResponse.json({ policies: items?.map((policy) => policy.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerUpdate.ListPoliciesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Update Management
 * @category ServerUpdate
 */
export interface ListPolicies extends Binding.Service<
  ListPolicies,
  "Stackit.ServerUpdate.ListPolicies",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListPoliciesRequest,
    ) => Effect.Effect<
      serverUpdate.GetUpdatePoliciesResponse,
      serverUpdate.ListUpdatePoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListPolicies = Binding.Service<ListPolicies>("Stackit.ServerUpdate.ListPolicies");
