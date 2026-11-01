import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteAlertConfigRouteRequest extends Omit<
  observability.DeleteAlertConfigRouteRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteAlertConfigRoute`: remove the route of one
 * receiver.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteAlertConfigRouteHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If an `AlertConfig` resource declares this route, its next reconcile creates it
 * again.
 *
 * ### Removing a Route
 * **Example:** Remove a route from a Cloudflare Worker
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
 *     const deleteAlertConfigRoute =
 *       yield* Stackit.Observability.DeleteAlertConfigRoute(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteAlertConfigRoute({ receiver: "on-call" });
 *         return yield* HttpServerResponse.json({ root: live.data.receiver });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteAlertConfigRouteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteAlertConfigRoute extends Binding.Service<
  DeleteAlertConfigRoute,
  "Stackit.Observability.DeleteAlertConfigRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteAlertConfigRouteRequest,
    ) => Effect.Effect<
      observability.AlertConfigRouteResponse,
      observability.DeleteAlertConfigRouteError,
      RuntimeContext
    >
  >
> {}

export const DeleteAlertConfigRoute = Binding.Service<DeleteAlertConfigRoute>(
  "Stackit.Observability.DeleteAlertConfigRoute",
);
