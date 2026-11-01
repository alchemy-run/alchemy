import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateLogsAlertGroupRequest extends Omit<
  observability.UpdateLogsAlertgroupRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `updateLogsAlertgroup`: replace a logs alert
 * group's interval and rules.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link UpdateLogsAlertGroupHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If a `LogsAlertGroup` resource declares this group, its next reconcile overwrites
 * what this binding changed. Needs a plan with logs, such as
 * `Observability-Starter-EU01`.
 *
 * ### Updating a Logs Group
 * **Example:** Replace the rules from a Cloudflare Worker
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
 *     const updateLogsAlertGroup =
 *       yield* Stackit.Observability.UpdateLogsAlertGroup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateLogsAlertGroup({
 *           groupName: "orders-logs",
 *           interval: "5m",
 *           rules: [{ alert: "ManyErrors", expr: 'sum(rate({app="orders"} |= "error" [5m])) > 1', for: "5m" }],
 *         });
 *         return yield* HttpServerResponse.json({ groups: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.UpdateLogsAlertGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface UpdateLogsAlertGroup extends Binding.Service<
  UpdateLogsAlertGroup,
  "Stackit.Observability.UpdateLogsAlertGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateLogsAlertGroupRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.UpdateLogsAlertgroupError,
      RuntimeContext
    >
  >
> {}

export const UpdateLogsAlertGroup = Binding.Service<UpdateLogsAlertGroup>(
  "Stackit.Observability.UpdateLogsAlertGroup",
);
