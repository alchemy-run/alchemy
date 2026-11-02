import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateLogsAlertGroupRequest extends Omit<
  observability.CreateLogsAlertgroupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `createLogsAlertgroups`: add a group of LogQL
 * alert rules to an instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateLogsAlertGroupHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * Needs a plan with logs, such as `Observability-Starter-EU01`.
 *
 * ### Creating a Logs Group
 * **Example:** Create a logs group from a Cloudflare Worker
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
 *     const createLogsAlertGroup =
 *       yield* Stackit.Observability.CreateLogsAlertGroup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* createLogsAlertGroup({
 *           name: "orders-logs",
 *           rules: [{ alert: "ManyErrors", expr: 'sum(rate({app="orders"} |= "error" [5m])) > 1', for: "5m" }],
 *         });
 *         return yield* HttpServerResponse.json({ groups: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.CreateLogsAlertGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface CreateLogsAlertGroup extends Binding.Service<
  CreateLogsAlertGroup,
  "Stackit.Observability.CreateLogsAlertGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateLogsAlertGroupRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.CreateLogsAlertgroupsError,
      RuntimeContext
    >
  >
> {}

export const CreateLogsAlertGroup = Binding.Service<CreateLogsAlertGroup>(
  "Stackit.Observability.CreateLogsAlertGroup",
);
