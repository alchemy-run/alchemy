import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListPlansRequest extends Omit<observability.ListPlansRequest, "projectId"> {}

/**
 * Runtime binding for Observability `listPlans`: list the plans available to the
 * project of the bound instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListPlansHttp}. The instance's project is injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.plan.list`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest.
 *
 * ### Listing Plans
 * **Example:** List the plan names from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const listPlans = yield* Stackit.Observability.ListPlans(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listPlans();
 *         return yield* HttpServerResponse.json({
 *           plans: live.plans.map((plan) => plan.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListPlansHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListPlans extends Binding.Service<
  ListPlans,
  "Stackit.Observability.ListPlans",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListPlansRequest,
    ) => Effect.Effect<observability.PlansResponse, observability.ListPlansError, RuntimeContext>
  >
> {}

export const ListPlans = Binding.Service<ListPlans>("Stackit.Observability.ListPlans");
