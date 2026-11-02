import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface ListApplicationsRequest extends Omit<
  sca.ListApplicationsRequest,
  "projectId" | "region" | "environmentId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `listApplications`: list the applications in an environment.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link ListApplicationsHttp}. The environment's project, region and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every environment in the project.
 *
 * ### Listing Applications
 * **Example:** List the applications in the bound environment
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
 *     const listApplications = yield* Stackit.ContainerApplications.ListApplications(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listApplications();
 *         return yield* HttpServerResponse.json((items ?? []).map((item) => item.displayName));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListApplicationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "Stackit.ContainerApplications.ListApplications",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ListApplicationsRequest,
    ) => Effect.Effect<sca.ListApplicationsResponse, sca.ListApplicationsError, RuntimeContext>
  >
> {}

export const ListApplications = Binding.Service<ListApplications>(
  "Stackit.ContainerApplications.ListApplications",
);
