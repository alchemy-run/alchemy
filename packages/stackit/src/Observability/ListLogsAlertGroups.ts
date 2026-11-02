import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListLogsAlertGroupsRequest extends Omit<
  observability.ListLogsAlertgroupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listLogsAlertgroups`: list an instance's logs
 * alert groups.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListLogsAlertGroupsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * Needs a plan with logs, such as `Observability-Starter-EU01`.
 *
 * ### Listing Logs Groups
 * **Example:** List the group names from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {
 *   plan: "Observability-Starter-EU01",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const listLogsAlertGroups =
 *       yield* Stackit.Observability.ListLogsAlertGroups(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listLogsAlertGroups();
 *         return yield* HttpServerResponse.json({
 *           groups: live.data.map((group) => group.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListLogsAlertGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListLogsAlertGroups extends Binding.Service<
  ListLogsAlertGroups,
  "Stackit.Observability.ListLogsAlertGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListLogsAlertGroupsRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.ListLogsAlertgroupsError,
      RuntimeContext
    >
  >
> {}

export const ListLogsAlertGroups = Binding.Service<ListLogsAlertGroups>(
  "Stackit.Observability.ListLogsAlertGroups",
);
