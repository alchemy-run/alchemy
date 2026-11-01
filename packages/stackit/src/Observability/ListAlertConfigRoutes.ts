import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAlertConfigRoutesRequest extends Omit<
  observability.ListAlertConfigRoutesRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listAlertConfigRoutes`: read an instance's alert
 * routing tree.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAlertConfigRoutesHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading the Routing Tree
 * **Example:** Read the root route from a Cloudflare Worker
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
 *     const listAlertConfigRoutes =
 *       yield* Stackit.Observability.ListAlertConfigRoutes(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listAlertConfigRoutes();
 *         return yield* HttpServerResponse.json({ receiver: live.data.receiver });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListAlertConfigRoutesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListAlertConfigRoutes extends Binding.Service<
  ListAlertConfigRoutes,
  "Stackit.Observability.ListAlertConfigRoutes",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListAlertConfigRoutesRequest,
    ) => Effect.Effect<
      observability.AlertConfigRouteResponse,
      observability.ListAlertConfigRoutesError,
      RuntimeContext
    >
  >
> {}

export const ListAlertConfigRoutes = Binding.Service<ListAlertConfigRoutes>(
  "Stackit.Observability.ListAlertConfigRoutes",
);
