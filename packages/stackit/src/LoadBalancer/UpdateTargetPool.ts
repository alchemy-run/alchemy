import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { LoadBalancer } from "./LoadBalancer.ts";

export interface UpdateTargetPoolRequest extends Omit<
  lb.UpdateTargetPoolRequest,
  "projectId" | "region" | "name" | "bodyName"
> {}

/**
 * Runtime binding for Load Balancer `UpdateTargetPool`: replace one target pool's
 * content from deployed code, for example to register targets as they scale. The
 * request is the pool's new full content, so read it first to add a single
 * target. It can't create or rename a pool, and other pools are left unchanged.
 *
 * Targets registered this way drift from the `targetPools` declared on the
 * {@link LoadBalancer}: the next update of that resource sends the declared pools
 * and removes them. A deploy that leaves the props unchanged doesn't touch them.
 *
 * Bind this operation to a {@link LoadBalancer} in a Function/Worker init phase
 * and provide {@link UpdateTargetPoolHttp}. The load balancer's project, region
 * and name are injected into each request. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `nlb.targetpool.replace` on the project
 * holding the load balancer, so it reaches every load balancer in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * load balancer. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Updating a Target Pool
 * **Example:** Replace a pool's targets from a Cloudflare Worker
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
 *     const updateTargetPool = yield* Stackit.LoadBalancer.UpdateTargetPool(yield* Balancer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const pool = yield* updateTargetPool({
 *           targetPoolName: "web",
 *           targetPort: 8080,
 *           targets: [{ ip: "10.0.1.10" }, { ip: "10.0.1.11" }],
 *         });
 *         return yield* HttpServerResponse.json({ targets: pool.targets?.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.UpdateTargetPoolHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface UpdateTargetPool extends Binding.Service<
  UpdateTargetPool,
  "Stackit.LoadBalancer.UpdateTargetPool",
  (
    loadBalancer: LoadBalancer,
  ) => Effect.Effect<
    (
      request: UpdateTargetPoolRequest,
    ) => Effect.Effect<lb.TargetPool, lb.UpdateTargetPoolError, RuntimeContext>
  >
> {}

export const UpdateTargetPool = Binding.Service<UpdateTargetPool>(
  "Stackit.LoadBalancer.UpdateTargetPool",
);
