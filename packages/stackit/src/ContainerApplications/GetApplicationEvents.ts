import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface GetApplicationEventsRequest extends Omit<
  sca.GetApplicationEventsRequest,
  "projectId" | "region" | "environmentId" | "applicationId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `getApplicationEvents`: read an application's events.
 *
 * Bind this operation to an {@link Application} in a Function/Worker init phase and
 * provide {@link GetApplicationEventsHttp}. The application's project, region, environment and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every application in the project.
 *
 * ### Reading Events
 * **Example:** Read the bound application's events
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Backend = Effect.gen(function* () {
 *   const apps = yield* Apps;
 *   return yield* Stackit.ContainerApplications.Application("Backend", {
 *     environmentId: apps.environmentId,
 *     image: "ghcr.io/my-org/backend:v1.0.0",
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const backend = yield* Backend;
 *     const getEvents = yield* Stackit.ContainerApplications.GetApplicationEvents(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* getEvents();
 *         return yield* HttpServerResponse.json((events ?? []).map((event) => event.message));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.GetApplicationEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface GetApplicationEvents extends Binding.Service<
  GetApplicationEvents,
  "Stackit.ContainerApplications.GetApplicationEvents",
  (
    application: Application<any>,
  ) => Effect.Effect<
    (
      request?: GetApplicationEventsRequest,
    ) => Effect.Effect<
      sca.GetApplicationEventsResponse,
      sca.GetApplicationEventsError,
      RuntimeContext
    >
  >
> {}

export const GetApplicationEvents = Binding.Service<GetApplicationEvents>(
  "Stackit.ContainerApplications.GetApplicationEvents",
);
