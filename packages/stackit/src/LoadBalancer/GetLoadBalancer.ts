import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadBalancer } from "./LoadBalancer.ts";

/**
 * Runtime binding for Load Balancer `GetLoadBalancer`: read a load balancer's
 * status, addresses, target pools and reported errors.
 *
 * Bind this operation to a {@link LoadBalancer} in a Function/Worker init phase
 * and provide {@link GetLoadBalancerHttp}. The load balancer's project, region
 * and name are injected into each request. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `nlb.loadbalancer.get` on the project
 * holding the load balancer, so it reaches every load balancer in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * load balancer. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading the Load Balancer
 * **Example:** Report status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Balancer = Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: "11111111-1111-4111-8111-111111111111" }],
 *   options: { ephemeralAddress: true },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getLoadBalancer = yield* Stackit.LoadBalancer.GetLoadBalancer(yield* Balancer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getLoadBalancer();
 *         return yield* HttpServerResponse.json({
 *           status: live.status,
 *           address: live.externalAddress,
 *           errors: live.errors,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.GetLoadBalancerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface GetLoadBalancer extends Binding.Service<
  GetLoadBalancer,
  "Stackit.LoadBalancer.GetLoadBalancer",
  (
    loadBalancer: LoadBalancer,
  ) => Effect.Effect<() => Effect.Effect<lb.LoadBalancer2, lb.GetLoadBalancerError, RuntimeContext>>
> {}

export const GetLoadBalancer = Binding.Service<GetLoadBalancer>(
  "Stackit.LoadBalancer.GetLoadBalancer",
);
