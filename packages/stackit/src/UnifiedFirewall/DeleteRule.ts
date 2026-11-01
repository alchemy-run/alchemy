import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface DeleteRuleRequest extends Omit<ufw.DeleteRuleRequest, "projectId" | "regionId"> {}

/**
 * Runtime binding for Unified Firewall `deleteRule`: delete one rule by its id at runtime. It only touches that rule.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such
 * as a `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init
 * phase and provide {@link DeleteRuleHttp}. Its project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.delete` on the project, so it reaches every rule in
 * that project: STACKIT binds roles on projects, folders and organizations, not on a single rule.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Unblocking at Runtime
 * **Example:** Remove a rule
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Web = Stackit.IaaS.SecurityGroup("Web", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const deleteRule = yield* Stackit.UnifiedFirewall.DeleteRule(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteRule({ ruleId: "00000000-0000-0000-0000-000000000000" });
 *         return HttpServerResponse.text("deleted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.DeleteRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface DeleteRule extends Binding.Service<
  DeleteRule,
  "Stackit.UnifiedFirewall.DeleteRule",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: DeleteRuleRequest,
    ) => Effect.Effect<ufw.DeleteRuleResponse, ufw.DeleteRuleError, RuntimeContext>
  >
> {}

export const DeleteRule = Binding.Service<DeleteRule>("Stackit.UnifiedFirewall.DeleteRule");
