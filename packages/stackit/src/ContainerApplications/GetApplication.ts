import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Application } from "./Application.ts";

export interface GetApplicationRequest extends Omit<
  sca.GetApplicationRequest,
  "projectId" | "region" | "environmentId" | "applicationId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `getApplication`: read an application's status, domains, containers and scaling. A container variable's value stays `Redacted`.
 *
 * Bind this operation to an {@link Application} in a Function/Worker init phase and
 * provide {@link GetApplicationHttp}. The application's project, region, environment and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every application in the project.
 *
 * ### Reading an Application
 * **Example:** Read the bound application from a Cloudflare Worker
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
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getApplication();
 *         return yield* HttpServerResponse.json({ status: live.status?.current, domain: live.status?.domains?.default });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.GetApplicationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface GetApplication extends Binding.Service<
  GetApplication,
  "Stackit.ContainerApplications.GetApplication",
  (
    application: Application<any>,
  ) => Effect.Effect<
    (
      request?: GetApplicationRequest,
    ) => Effect.Effect<sca.Application, sca.GetApplicationError, RuntimeContext>
  >
> {}

export const GetApplication = Binding.Service<GetApplication>(
  "Stackit.ContainerApplications.GetApplication",
);
