import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAlertConfigRouteRequest extends Omit<
  observability.GetAlertConfigRouteRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getAlertConfigRoute`: read the route of one
 * receiver.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetAlertConfigRouteHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The API documents no not-found answer for this operation, so a missing route has no
 * typed error of its own.
 *
 * ### Reading a Route
 * **Example:** Read a route from a Cloudflare Worker
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
 *     const getAlertConfigRoute =
 *       yield* Stackit.Observability.GetAlertConfigRoute(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getAlertConfigRoute({ receiver: "on-call" });
 *         return yield* HttpServerResponse.json({ groupWait: live.data.groupWait });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetAlertConfigRouteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetAlertConfigRoute extends Binding.Service<
  GetAlertConfigRoute,
  "Stackit.Observability.GetAlertConfigRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAlertConfigRouteRequest,
    ) => Effect.Effect<
      observability.AlertConfigRouteResponse,
      observability.GetAlertConfigRouteError,
      RuntimeContext
    >
  >
> {}

export const GetAlertConfigRoute = Binding.Service<GetAlertConfigRoute>(
  "Stackit.Observability.GetAlertConfigRoute",
);
