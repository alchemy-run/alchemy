import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface GetApplicationLogsRequest extends Omit<
  sca.GetApplicationLogsRequest,
  "projectId" | "region" | "environmentId" | "applicationId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `getApplicationLogs`: read the logs of one container in one instance of an application. `previous` asks for the container's last failed run. Find instance names through `Stackit.ContainerApplications.GetApplication`.
 *
 * Bind this operation to an {@link Application} in a Function/Worker init phase and
 * provide {@link GetApplicationLogsHttp}. The application's project, region, environment and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every application in the project.
 *
 * ### Reading Logs
 * **Example:** Read one container of the bound application
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
 *     const getApplication = yield* Stackit.ContainerApplications.GetApplication(backend);
 *     const getLogs = yield* Stackit.ContainerApplications.GetApplicationLogs(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getApplication();
 *         const instance = live.status?.instances?.[0]?.name ?? "";
 *         const { logs } = yield* getLogs({ instance, container: "app" });
 *         return yield* HttpServerResponse.json((logs ?? []).map((line) => line.message));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide([
 *       Stackit.ContainerApplications.GetApplicationHttp,
 *       Stackit.ContainerApplications.GetApplicationLogsHttp,
 *     ])),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface GetApplicationLogs extends Binding.Service<
  GetApplicationLogs,
  "Stackit.ContainerApplications.GetApplicationLogs",
  (
    application: Application<any>,
  ) => Effect.Effect<
    (
      request: GetApplicationLogsRequest,
    ) => Effect.Effect<sca.GetApplicationLogsResponse, sca.GetApplicationLogsError, RuntimeContext>
  >
> {}

export const GetApplicationLogs = Binding.Service<GetApplicationLogs>(
  "Stackit.ContainerApplications.GetApplicationLogs",
);
