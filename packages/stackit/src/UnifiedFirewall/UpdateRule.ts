import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface UpdateRuleRequest extends Omit<ufw.UpdateRuleRequest, "projectId" | "regionId"> {}

/**
 * Runtime binding for Unified Firewall `updateRule`: change a rule's range and traffic at runtime. A rule in a stack keeps the change until a deploy changes its props. It settles asynchronously: poll `GetRule` until `status` is `Active`.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such
 * as a `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init
 * phase and provide {@link UpdateRuleHttp}. Its project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.update` on the project, so it reaches every rule in
 * that project: STACKIT binds roles on projects, folders and organizations, not on a single rule.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Changing a Range
 * **Example:** Move a rule to another range
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
 *     const updateRule = yield* Stackit.UnifiedFirewall.UpdateRule(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { refId } = yield* updateRule({ ruleId: "00000000-0000-0000-0000-000000000000", sourceIP: "198.51.100.0/24" });
 *         return yield* HttpServerResponse.json({ refId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.UpdateRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface UpdateRule extends Binding.Service<
  UpdateRule,
  "Stackit.UnifiedFirewall.UpdateRule",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: UpdateRuleRequest,
    ) => Effect.Effect<ufw.UpdateRuleResponse, ufw.UpdateRuleError, RuntimeContext>
  >
> {}

export const UpdateRule = Binding.Service<UpdateRule>("Stackit.UnifiedFirewall.UpdateRule");
