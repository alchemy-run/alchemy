import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateAlertConfigRouteRequest extends Omit<
  observability.CreateAlertConfigRouteRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `createAlertConfigRoute`: add a route for one
 * receiver.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateAlertConfigRouteHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * An `AlertConfig` resource writes the instance's whole alert configuration, so if one
 * manages this instance its next reconcile removes what this binding added, unless the
 * receiver's name starts with `alchemy-webhook-`.
 *
 * ### Adding a Route
 * **Example:** Route alerts to a receiver from a Cloudflare Worker
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
 *     const createAlertConfigRoute =
 *       yield* Stackit.Observability.CreateAlertConfigRoute(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* createAlertConfigRoute({
 *           receiver: "on-call",
 *           matchers: ['severity="page"'],
 *           continue: true,
 *         });
 *         return yield* HttpServerResponse.json({ root: live.data.receiver });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.CreateAlertConfigRouteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface CreateAlertConfigRoute extends Binding.Service<
  CreateAlertConfigRoute,
  "Stackit.Observability.CreateAlertConfigRoute",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateAlertConfigRouteRequest,
    ) => Effect.Effect<
      observability.AlertConfigRouteResponse,
      observability.CreateAlertConfigRouteError,
      RuntimeContext
    >
  >
> {}

export const CreateAlertConfigRoute = Binding.Service<CreateAlertConfigRoute>(
  "Stackit.Observability.CreateAlertConfigRoute",
);
