import type * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

/**
 * Runtime binding for IP Lists `ListIPLists`: list every IP list of a project
 * and region, without their CIDRs.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListIPListsHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `lb-ip-lists.loadbalancer.list` on the
 * project of the bound resource, the narrowest scope STACKIT binds roles on,
 * so it reaches that whole project. The deployer needs `iam.role.add` on that
 * scope to define the role.
 *
 * ### Listing Lists
 * **Example:** List names from a Cloudflare Worker
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
 *     const listIPLists = yield* Stackit.IPLists.ListIPLists(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listIPLists();
 *         return yield* HttpServerResponse.json({
 *           names: (items ?? []).map((list) => list.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IPLists.ListIPListsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Load Balancer IP Lists
 * @category IPLists
 */
export interface ListIPLists extends Binding.Service<
  ListIPLists,
  "Stackit.IPLists.ListIPLists",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    () => Effect.Effect<ipLists.ListIPListsResponse, ipLists.ListIPListsError, RuntimeContext>
  >
> {}

export const ListIPLists = Binding.Service<ListIPLists>("Stackit.IPLists.ListIPLists");
