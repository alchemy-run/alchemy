import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface ListEnvironmentsRequest extends Omit<
  sca.ListEnvironmentsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `listEnvironments`: list the environments of the bound environment's project.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link ListEnvironmentsHttp}. The environment's project and region are injected into each request, and it reads the whole project. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.environment.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches the whole project.
 *
 * ### Listing Environments
 * **Example:** List the environments in the project
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
 *     const listEnvironments = yield* Stackit.ContainerApplications.ListEnvironments(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listEnvironments();
 *         return yield* HttpServerResponse.json((items ?? []).map((item) => item.displayName));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListEnvironmentsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface ListEnvironments extends Binding.Service<
  ListEnvironments,
  "Stackit.ContainerApplications.ListEnvironments",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentsRequest,
    ) => Effect.Effect<sca.ListEnvironmentsResponse, sca.ListEnvironmentsError, RuntimeContext>
  >
> {}

export const ListEnvironments = Binding.Service<ListEnvironments>(
  "Stackit.ContainerApplications.ListEnvironments",
);
