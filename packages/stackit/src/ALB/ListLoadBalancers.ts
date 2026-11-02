import type * as alb from "@distilled.cloud/stackit/alb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListLoadBalancersRequest extends Omit<
  alb.ListLoadBalancersRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Application Load Balancer `ListLoadBalancers`: list one
 * page of the Application Load Balancers in a project and region. Pass
 * `pageId` from a response's `nextPageId` to read the next page.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListLoadBalancersHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.loadbalancer.list` on the project of
 * the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope
 * to define the role.
 *
 * ### Listing Load Balancers
 * **Example:** List load balancer names from a Cloudflare Worker
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
 *     const listLoadBalancers = yield* Stackit.ALB.ListLoadBalancers(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { loadBalancers } = yield* listLoadBalancers({ pageSize: "50" });
 *         return yield* HttpServerResponse.json({
 *           names: (loadBalancers ?? []).map((balancer) => balancer.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ALB.ListLoadBalancersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export interface ListLoadBalancers extends Binding.Service<
  ListLoadBalancers,
  "Stackit.ALB.ListLoadBalancers",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListLoadBalancersRequest,
    ) => Effect.Effect<alb.ListLoadBalancersResponse, alb.ListLoadBalancersError, RuntimeContext>
  >
> {}

export const ListLoadBalancers = Binding.Service<ListLoadBalancers>(
  "Stackit.ALB.ListLoadBalancers",
);
