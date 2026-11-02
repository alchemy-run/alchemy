import type * as alb from "@distilled.cloud/stackit/alb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

/**
 * Runtime binding for Application Load Balancer `GetQuota`: read how many
 * Application Load Balancers and observability credentials a project may have
 * and how many it uses.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link GetQuotaHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.quota.get` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
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
 *     const getQuota = yield* Stackit.ALB.GetQuota(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const quota = yield* getQuota();
 *         return yield* HttpServerResponse.json({
 *           remaining: (quota.maxLoadBalancers ?? 0) - (quota.usedLoadBalancers ?? 0),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ALB.GetQuotaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export interface GetQuota extends Binding.Service<
  GetQuota,
  "Stackit.ALB.GetQuota",
  (
    scope: BindingScope,
  ) => Effect.Effect<() => Effect.Effect<alb.GetQuotaResponse, alb.GetQuotaError, RuntimeContext>>
> {}

export const GetQuota = Binding.Service<GetQuota>("Stackit.ALB.GetQuota");
