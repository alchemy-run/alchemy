import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for Load Balancer `ListPlans`: list the service plans of a
 * region, with their flavor and connection limits.
 *
 * Call it with no resource in a Function/Worker init phase and provide
 * {@link ListPlansHttp}. Pass the region on each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: no role. The spec disables authorization on this operation, so the host
 * only needs an identity to sign with.
 *
 * ### Listing Plans
 * **Example:** List a region's plans from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listPlans = yield* Stackit.LoadBalancer.ListPlans();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { validPlans } = yield* listPlans({ region: "eu01" });
 *         return yield* HttpServerResponse.json({
 *           plans: (validPlans ?? []).map((plan) => plan.planId),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.ListPlansHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface ListPlans extends Binding.Service<
  ListPlans,
  "Stackit.LoadBalancer.ListPlans",
  () => Effect.Effect<
    (
      request: lb.ListPlansRequest,
    ) => Effect.Effect<lb.ListPlansResponse, lb.ListPlansError, RuntimeContext>
  >
> {}

export const ListPlans = Binding.Service<ListPlans>("Stackit.LoadBalancer.ListPlans");
