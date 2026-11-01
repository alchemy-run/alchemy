import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface UpdateApplicationRequest extends Omit<
  sca.UpdateApplicationRequest,
  "projectId" | "region" | "environmentId" | "applicationId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `updateApplication`: change an application at runtime, such as stopping it, starting it or scaling it. The schema requires `containers`, `displayName` and `scaling` on every call, so read them first through `Stackit.ContainerApplications.GetApplication`. A later deploy puts back what the stack declares, if the stack's props or program have changed by then.
 *
 * Bind this operation to an {@link Application} in a Function/Worker init phase and
 * provide {@link UpdateApplicationHttp}. The application's project, region, environment and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.update`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every application in the project.
 *
 * ### Stopping an Application
 * **Example:** Stop the bound application
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
 *     const updateApplication = yield* Stackit.ContainerApplications.UpdateApplication(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getApplication();
 *         const updated = yield* updateApplication({
 *           containers: live.containers,
 *           displayName: live.displayName,
 *           network: live.network,
 *           scaling: live.scaling,
 *           stopped: true,
 *         });
 *         return yield* HttpServerResponse.json({ stopped: updated.stopped });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide([
 *       Stackit.ContainerApplications.GetApplicationHttp,
 *       Stackit.ContainerApplications.UpdateApplicationHttp,
 *     ])),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface UpdateApplication extends Binding.Service<
  UpdateApplication,
  "Stackit.ContainerApplications.UpdateApplication",
  (
    application: Application<any>,
  ) => Effect.Effect<
    (
      request: UpdateApplicationRequest,
    ) => Effect.Effect<sca.Application, sca.UpdateApplicationError, RuntimeContext>
  >
> {}

export const UpdateApplication = Binding.Service<UpdateApplication>(
  "Stackit.ContainerApplications.UpdateApplication",
);
