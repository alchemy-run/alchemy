import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAlertRulesRequest extends Omit<
  observability.ListAlertrulesRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listAlertrules`: list a group's alert rules.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAlertRulesHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Listing Rules
 * **Example:** List the rule names from a Cloudflare Worker
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
 *     const listAlertRules = yield* Stackit.Observability.ListAlertRules(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listAlertRules({ groupName: "orders" });
 *         return yield* HttpServerResponse.json({
 *           rules: live.data.map((rule) => rule.alert),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListAlertRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListAlertRules extends Binding.Service<
  ListAlertRules,
  "Stackit.Observability.ListAlertRules",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListAlertRulesRequest,
    ) => Effect.Effect<
      observability.AlertRulesResponse,
      observability.ListAlertrulesError,
      RuntimeContext
    >
  >
> {}

export const ListAlertRules = Binding.Service<ListAlertRules>(
  "Stackit.Observability.ListAlertRules",
);
