import type * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Router } from "./Router.ts";

export interface ListDestinationsRequest extends Omit<
  router.ListDestinationsRequest,
  "projectId" | "regionId" | "telemetryRouterId"
> {}

/**
 * Runtime binding for Telemetry Router `listDestinations`: list one page of the
 * destinations on a router. Pass `pageToken` from a response's `nextPageToken` to
 * read the next page.
 *
 * Bind this operation to a {@link Router} in a Function/Worker init phase and
 * provide {@link ListDestinationsHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `telemetry-router.destination.list` on the
 * project of the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Listing Destinations
 * **Example:** List a router's destinations from a Cloudflare Worker
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
 *     const listDestinations = yield* Stackit.Telemetry.ListDestinations(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { destinations } = yield* listDestinations({ pageSize: 50 });
 *         return yield* HttpServerResponse.json({ names: destinations.map((destination) => destination.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.ListDestinationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export interface ListDestinations extends Binding.Service<
  ListDestinations,
  "Stackit.Telemetry.ListDestinations",
  (
    router: Router,
  ) => Effect.Effect<
    (
      request: ListDestinationsRequest,
    ) => Effect.Effect<
      router.ListDestinationsResponse,
      router.ListDestinationsError,
      RuntimeContext
    >
  >
> {}

export const ListDestinations = Binding.Service<ListDestinations>(
  "Stackit.Telemetry.ListDestinations",
);
