import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Destination } from "./Destination.ts";

export interface GetDestinationRequest extends Omit<
  router.GetDestinationRequest,
  "projectId" | "regionId" | "telemetryRouterId" | "destinationId"
> {}

/**
 * Runtime binding for Telemetry Router `getDestination`: read a destination's status
 * and configuration. STACKIT doesn't document whether the answer holds the secrets;
 * they arrive `Redacted` if it does.
 *
 * Bind this operation to a {@link Destination} in a Function/Worker init phase and
 * provide {@link GetDestinationHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.destination.get` on the
 * project of the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Reading the Destination
 * **Example:** Read the destination from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AuditLogs = Stackit.Telemetry.Router("AuditLogs", {});
 * export const Siem = AuditLogs.pipe(
 *   Effect.flatMap((router) =>
 *     Stackit.Telemetry.Destination("Siem", {
 *       routerId: router.routerId,
 *       config: {
 *         type: "OpenTelemetry",
 *         uri: "https://siem.example.com/otlp/v1/logs",
 *         bearerToken: "replace-with-a-secret",
 *       },
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Siem;
 *     const getDestination = yield* Stackit.Telemetry.GetDestination(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getDestination({});
 *         return yield* HttpServerResponse.json({ status: live.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetDestinationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface GetDestination extends Binding.Service<
  GetDestination,
  "Stackit.Telemetry.GetDestination",
  (
    destination: Destination,
  ) => Effect.Effect<
    (
      request: GetDestinationRequest,
    ) => Effect.Effect<router.DestinationResponse, router.GetDestinationError, RuntimeContext>
  >
> {}

export const GetDestination = Binding.Service<GetDestination>("Stackit.Telemetry.GetDestination");
