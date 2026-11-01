import type * as edge from "@distilled.cloud/stackit/edge";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for Edge Cloud `listPlansProject`: the service plans a project can
 * use, with the minimum number of hosts charged and the maximum supported by each.
 *
 * STACKIT's API spec turns authorization off for this operation, so this binding has
 * no bound resource and grants no role; pass the project in each request. Provide
 * {@link ListPlansHttp}. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * ### Reading the Plans
 * **Example:** List a project's plans
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
 *     const listPlans = yield* Stackit.EdgeCloud.ListPlans();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { validPlans } = yield* listPlans({
 *           projectId: "11111111-2222-3333-4444-555555555555",
 *         });
 *         return yield* HttpServerResponse.json(validPlans ?? []);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.EdgeCloud.ListPlansHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export interface ListPlans extends Binding.Service<
  ListPlans,
  "Stackit.EdgeCloud.ListPlans",
  () => Effect.Effect<
    (
      request: edge.ListPlansProjectRequest,
    ) => Effect.Effect<edge.PlanList, edge.ListPlansProjectError, RuntimeContext>
  >
> {}

export const ListPlans = Binding.Service<ListPlans>("Stackit.EdgeCloud.ListPlans");
