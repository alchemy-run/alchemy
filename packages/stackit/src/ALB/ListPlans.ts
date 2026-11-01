import type * as alb from "@distilled.cloud/stackit/alb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for Application Load Balancer `ListPlans`: list the service
 * plans of a region, with their flavor and connection limits.
 *
 * Call it with no resource in a Function/Worker init phase and provide
 * {@link ListPlansHttp}. Pass the region on each request. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: no role. The spec disables authorization on this operation, so the
 * host only needs an identity to sign with.
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
 *     const listPlans = yield* Stackit.ALB.ListPlans();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { validPlans } = yield* listPlans({ region: "eu01" });
 *         return yield* HttpServerResponse.json({
 *           plans: (validPlans ?? []).map((plan) => plan.planId),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ALB.ListPlansHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export interface ListPlans extends Binding.Service<
  ListPlans,
  "Stackit.ALB.ListPlans",
  () => Effect.Effect<
    (
      request: alb.ListPlansRequest,
    ) => Effect.Effect<alb.ListPlansResponse, alb.ListPlansError, RuntimeContext>
  >
> {}

export const ListPlans = Binding.Service<ListPlans>("Stackit.ALB.ListPlans");
