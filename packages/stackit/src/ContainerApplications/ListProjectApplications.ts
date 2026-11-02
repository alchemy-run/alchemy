import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface ListProjectApplicationsRequest extends Omit<
  sca.ListProjectApplicationsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `listProjectApplications`: list the applications in every environment of the bound environment's project.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link ListProjectApplicationsHttp}. The environment's project and region are injected into each request, and it reads the whole project. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.application.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches the whole project.
 *
 * ### Listing Applications
 * **Example:** List the applications in the project
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
 *     const listProjectApplications = yield* Stackit.ContainerApplications.ListProjectApplications(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listProjectApplications();
 *         return yield* HttpServerResponse.json((items ?? []).map((item) => item.displayName));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListProjectApplicationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface ListProjectApplications extends Binding.Service<
  ListProjectApplications,
  "Stackit.ContainerApplications.ListProjectApplications",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ListProjectApplicationsRequest,
    ) => Effect.Effect<
      sca.ListApplicationsResponse,
      sca.ListProjectApplicationsError,
      RuntimeContext
    >
  >
> {}

export const ListProjectApplications = Binding.Service<ListProjectApplications>(
  "Stackit.ContainerApplications.ListProjectApplications",
);
