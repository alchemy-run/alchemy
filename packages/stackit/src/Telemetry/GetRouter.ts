import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Router } from "./Router.ts";

export interface GetRouterRequest extends Omit<
  router.GetTelemetryRouterRequest,
  "projectId" | "regionId" | "telemetryRouterId"
> {}

/**
 * Runtime binding for Telemetry Router `getTelemetryRouter`: read a router's status,
 * filter and destination count.
 *
 * Bind this operation to a {@link Router} in a Function/Worker init phase and
 * provide {@link GetRouterHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.instance.get` on the project
 * of the bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading the Router
 * **Example:** Read the router from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AuditLogs = Stackit.Telemetry.Router("AuditLogs", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* AuditLogs;
 *     const getRouter = yield* Stackit.Telemetry.GetRouter(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getRouter({});
 *         return yield* HttpServerResponse.json({ status: live.status, destinations: live.destinationCount });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetRouterHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetRouter extends Binding.Service<
  GetRouter,
  "Stackit.Telemetry.GetRouter",
  (
    router: Router,
  ) => Effect.Effect<
    (
      request: GetRouterRequest,
    ) => Effect.Effect<
      router.TelemetryRouterResponse,
      router.GetTelemetryRouterError,
      RuntimeContext
    >
  >
> {}

export const GetRouter = Binding.Service<GetRouter>("Stackit.Telemetry.GetRouter");
