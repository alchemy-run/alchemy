import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface GetRuleRequest extends Omit<ufw.GetRuleRequest, "projectId" | "regionId"> {}

/**
 * Runtime binding for Unified Firewall `getRule`: read one rule by its id, with its status and any error message.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such
 * as a `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init
 * phase and provide {@link GetRuleHttp}. Its project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.get` on the project, so it reaches every rule in
 * that project: STACKIT binds roles on projects, folders and organizations, not on a single rule.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Rule
 * **Example:** Read a rule's status
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
 *     const getRule = yield* Stackit.UnifiedFirewall.GetRule(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rule = yield* getRule({ ruleId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ status: rule.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.GetRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface GetRule extends Binding.Service<
  GetRule,
  "Stackit.UnifiedFirewall.GetRule",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (request: GetRuleRequest) => Effect.Effect<ufw.RuleResponse, ufw.GetRuleError, RuntimeContext>
  >
> {}

export const GetRule = Binding.Service<GetRule>("Stackit.UnifiedFirewall.GetRule");
