import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetLogsAlertGroupRequest extends Omit<
  observability.GetLogsAlertgroupRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getLogsAlertgroup`: read one logs alert group and
 * its rules.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetLogsAlertGroupHttp}. The instance's project and id are injected
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
 * ### Reading a Logs Group
 * **Example:** Read a logs group from a Cloudflare Worker
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
 *     const getLogsAlertGroup =
 *       yield* Stackit.Observability.GetLogsAlertGroup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getLogsAlertGroup({ groupName: "orders-logs" });
 *         return yield* HttpServerResponse.json({ rules: live.data.rules.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetLogsAlertGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetLogsAlertGroup extends Binding.Service<
  GetLogsAlertGroup,
  "Stackit.Observability.GetLogsAlertGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetLogsAlertGroupRequest,
    ) => Effect.Effect<
      observability.AlertGroupResponse,
      observability.GetLogsAlertgroupError,
      RuntimeContext
    >
  >
> {}

export const GetLogsAlertGroup = Binding.Service<GetLogsAlertGroup>(
  "Stackit.Observability.GetLogsAlertGroup",
);
