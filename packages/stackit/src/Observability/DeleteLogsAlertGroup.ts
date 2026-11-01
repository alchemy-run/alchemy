import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteLogsAlertGroupRequest extends Omit<
  observability.DeleteLogsAlertgroupRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteLogsAlertgroup`: remove one logs alert
 * group.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteLogsAlertGroupHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If a `LogsAlertGroup` resource declares this group, its next reconcile creates it
 * again. Needs a plan with logs, such as `Observability-Starter-EU01`.
 *
 * ### Removing a Logs Group
 * **Example:** Remove a logs group from a Cloudflare Worker
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
 *     const deleteLogsAlertGroup =
 *       yield* Stackit.Observability.DeleteLogsAlertGroup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteLogsAlertGroup({ groupName: "orders-logs" });
 *         return yield* HttpServerResponse.json({ groups: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteLogsAlertGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteLogsAlertGroup extends Binding.Service<
  DeleteLogsAlertGroup,
  "Stackit.Observability.DeleteLogsAlertGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteLogsAlertGroupRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.DeleteLogsAlertgroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteLogsAlertGroup = Binding.Service<DeleteLogsAlertGroup>(
  "Stackit.Observability.DeleteLogsAlertGroup",
);
