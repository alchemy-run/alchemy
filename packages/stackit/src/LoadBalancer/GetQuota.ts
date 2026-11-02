import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

/**
 * Runtime binding for Load Balancer `GetQuota`: read how many load balancers and
 * observability credentials a project may have and how many it uses.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link GetQuotaHttp}. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `nlb.quota.get` on the project of the bound
 * resource. The quota belongs to the project, the narrowest scope STACKIT binds
 * roles on. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Quota
 * **Example:** Report remaining capacity from a Cloudflare Worker
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
 *     const getQuota = yield* Stackit.LoadBalancer.GetQuota(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const quota = yield* getQuota();
 *         return yield* HttpServerResponse.json({
 *           remaining: (quota.maxLoadBalancers ?? 0) - (quota.usedLoadBalancers ?? 0),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.GetQuotaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface GetQuota extends Binding.Service<
  GetQuota,
  "Stackit.LoadBalancer.GetQuota",
  (
    scope: BindingScope,
  ) => Effect.Effect<() => Effect.Effect<lb.GetQuotaResponse, lb.GetQuotaError, RuntimeContext>>
> {}

export const GetQuota = Binding.Service<GetQuota>("Stackit.LoadBalancer.GetQuota");
