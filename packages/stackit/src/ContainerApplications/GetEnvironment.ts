import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface GetEnvironmentRequest extends Omit<
  sca.GetEnvironmentRequest,
  "projectId" | "region" | "environmentId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `getEnvironment`: read an environment's status and how many applications it holds.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link GetEnvironmentHttp}. The environment's project, region and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.environment.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every environment in the project.
 *
 * ### Reading an Environment
 * **Example:** Read the bound environment from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     const getEnvironment = yield* Stackit.ContainerApplications.GetEnvironment(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getEnvironment();
 *         return yield* HttpServerResponse.json({ status: live.status?.current, applications: live.status?.applicationsNumber });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.GetEnvironmentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface GetEnvironment extends Binding.Service<
  GetEnvironment,
  "Stackit.ContainerApplications.GetEnvironment",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: GetEnvironmentRequest,
    ) => Effect.Effect<sca.Environment, sca.GetEnvironmentError, RuntimeContext>
  >
> {}

export const GetEnvironment = Binding.Service<GetEnvironment>(
  "Stackit.ContainerApplications.GetEnvironment",
);
