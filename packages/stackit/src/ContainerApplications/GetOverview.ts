import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface GetOverviewRequest extends Omit<sca.GetOverviewRequest, "projectId" | "region"> {}

/**
 * Runtime binding for STACKIT Container Applications' `getOverview`: read how many applications the bound environment's project has, and how many run.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link GetOverviewHttp}. The environment's project and region are injected into each request, and it reads the whole project. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.project.overview`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches the whole project.
 *
 * ### Reading the Overview
 * **Example:** Read the project overview
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
 *     const getOverview = yield* Stackit.ContainerApplications.GetOverview(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { summary } = yield* getOverview();
 *         return yield* HttpServerResponse.json({ running: summary?.applicationsRunning, total: summary?.applicationsTotal });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.GetOverviewHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface GetOverview extends Binding.Service<
  GetOverview,
  "Stackit.ContainerApplications.GetOverview",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: GetOverviewRequest,
    ) => Effect.Effect<sca.GetOverviewResponse, sca.GetOverviewError, RuntimeContext>
  >
> {}

export const GetOverview = Binding.Service<GetOverview>(
  "Stackit.ContainerApplications.GetOverview",
);
