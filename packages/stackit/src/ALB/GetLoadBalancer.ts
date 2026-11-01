import type * as alb from "@distilled.cloud/stackit/alb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadBalancer } from "./LoadBalancer.ts";

/**
 * Runtime binding for Application Load Balancer `GetLoadBalancer`: read an
 * Application Load Balancer's status, addresses, target pools and reported
 * errors.
 *
 * Bind this operation to a {@link LoadBalancer} in a Function/Worker init
 * phase and provide {@link GetLoadBalancerHttp}. The load balancer's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.loadbalancer.get` on the project
 * holding the load balancer, so it reaches every load balancer in that
 * project: STACKIT binds roles on projects, folders and organizations, not on
 * a single load balancer. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Reading the Load Balancer
 * **Example:** Report status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Balancer = Stackit.ALB.LoadBalancer("Web", {
 *   networks: [{ networkId: "11111111-1111-4111-8111-111111111111" }],
 *   options: { ephemeralAddress: true },
 *   listeners: [
 *     {
 *       name: "http",
 *       port: 80,
 *       protocol: "PROTOCOL_HTTP",
 *       http: { hosts: [{ host: "app.example.com", rules: [{ targetPool: "web" }] }] },
 *     },
 *   ],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getLoadBalancer = yield* Stackit.ALB.GetLoadBalancer(yield* Balancer);
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
 *   }).pipe(Effect.provide(Stackit.ALB.GetLoadBalancerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export interface GetLoadBalancer extends Binding.Service<
  GetLoadBalancer,
  "Stackit.ALB.GetLoadBalancer",
  (
    balancer: LoadBalancer,
  ) => Effect.Effect<
    () => Effect.Effect<alb.LoadBalancer, alb.GetLoadBalancerError, RuntimeContext>
  >
> {}

export const GetLoadBalancer = Binding.Service<GetLoadBalancer>("Stackit.ALB.GetLoadBalancer");
