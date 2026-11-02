import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteAlertRuleRequest extends Omit<
  observability.DeleteAlertruleRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteAlertrule`: remove one alert rule from a
 * group.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteAlertRuleHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If an `AlertGroup` resource declares this group, its next reconcile overwrites what
 * this binding changed.
 *
 * ### Removing a Rule
 * **Example:** Remove a rule from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const deleteAlertRule = yield* Stackit.Observability.DeleteAlertRule(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteAlertRule({ groupName: "orders", alertName: "HighLatency" });
 *         return yield* HttpServerResponse.json({ rules: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteAlertRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteAlertRule extends Binding.Service<
  DeleteAlertRule,
  "Stackit.Observability.DeleteAlertRule",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteAlertRuleRequest,
    ) => Effect.Effect<
      observability.AlertRulesResponse,
      observability.DeleteAlertruleError,
      RuntimeContext
    >
  >
> {}

export const DeleteAlertRule = Binding.Service<DeleteAlertRule>(
  "Stackit.Observability.DeleteAlertRule",
);
