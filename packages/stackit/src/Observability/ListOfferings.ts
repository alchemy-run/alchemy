import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListOfferingsRequest extends Omit<
  observability.ListOfferingsRequest,
  "projectId"
> {}

/**
 * Runtime binding for Observability `listOfferings`: read the product's description
 * and its plans.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListOfferingsHttp}. The instance's project is injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.plan.list`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest.
 *
 * ### Listing Offerings
 * **Example:** Read the offering from a Cloudflare Worker
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
 *     const listOfferings = yield* Stackit.Observability.ListOfferings(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listOfferings();
 *         return yield* HttpServerResponse.json({
 *           name: live.name, plans: live.plans.length,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListOfferingsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListOfferings extends Binding.Service<
  ListOfferings,
  "Stackit.Observability.ListOfferings",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListOfferingsRequest,
    ) => Effect.Effect<observability.Offerings, observability.ListOfferingsError, RuntimeContext>
  >
> {}

export const ListOfferings = Binding.Service<ListOfferings>("Stackit.Observability.ListOfferings");
