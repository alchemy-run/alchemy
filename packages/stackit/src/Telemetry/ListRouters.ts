import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListRoutersRequest extends Omit<
  router.ListTelemetryRoutersRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Telemetry Router `listTelemetryRouters`: list one page of the
 * routers in a project and region. Pass `pageToken` from a response's
 * `nextPageToken` to read the next page.
 *
 * Bind this operation to any resource in that project and region (a {@link
 * BindingScope}) in a Function/Worker init phase and provide {@link
 * ListRoutersHttp}. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.instance.list` on the project
 * of the bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Listing Routers
 * **Example:** List router names from a Cloudflare Worker
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
 *     const listRouters = yield* Stackit.Telemetry.ListRouters(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { telemetryRouters } = yield* listRouters({ pageSize: 50 });
 *         return yield* HttpServerResponse.json({ names: telemetryRouters.map((router) => router.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.ListRoutersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface ListRouters extends Binding.Service<
  ListRouters,
  "Stackit.Telemetry.ListRouters",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListRoutersRequest,
    ) => Effect.Effect<
      router.ListTelemetryRoutersResponse,
      router.ListTelemetryRoutersError,
      RuntimeContext
    >
  >
> {}

export const ListRouters = Binding.Service<ListRouters>("Stackit.Telemetry.ListRouters");
