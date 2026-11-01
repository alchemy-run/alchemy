import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import type { CreateRuleRequest } from "./CreateRule.ts";
import type { DeleteRuleRequest } from "./DeleteRule.ts";
import type { UpdateRuleRequest } from "./UpdateRule.ts";

/** The write operations on the rules of a bound project and region. */
export interface WriteRulesClient {
  /** Add a rule. It settles asynchronously, and isn't in any stack's state. */
  createRule(
    request: CreateRuleRequest,
  ): Effect.Effect<ufw.CreateRuleResponse, ufw.CreateRuleError, RuntimeContext>;
  /** Change a rule's range and traffic. It settles asynchronously. */
  updateRule(
    request: UpdateRuleRequest,
  ): Effect.Effect<ufw.UpdateRuleResponse, ufw.UpdateRuleError, RuntimeContext>;
  /** Delete one rule by its id. */
  deleteRule(
    request: DeleteRuleRequest,
  ): Effect.Effect<ufw.DeleteRuleResponse, ufw.DeleteRuleError, RuntimeContext>;
}

/**
 * Add, change and delete firewall rules of a project and region from a Function/Worker, one rule at a time.
 *
 * Bind it in the init phase to any resource in that project and region (a {@link BindingScope})
 * and provide {@link WriteRulesHttp}. Its project and region are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.create`, `ufw.instance.update` and
 * `ufw.instance.delete` on the project, so it reaches every rule in that project: STACKIT binds roles on projects, folders and organizations, not on a single rule. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Blocking at Runtime
 * **Example:** Add a rule during an incident
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
 *     const rules = yield* Stackit.UnifiedFirewall.WriteRules(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { refId } = yield* rules.createRule({ product: "edge-cloud", instanceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", type: "ACL", sourceIP: "192.0.2.0/24" });
 *         return yield* HttpServerResponse.json({ refId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.WriteRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface WriteRules extends Binding.Service<
  WriteRules,
  "Stackit.UnifiedFirewall.WriteRules",
  (scope: BindingScope) => Effect.Effect<WriteRulesClient>
> {}

export const WriteRules = Binding.Service<WriteRules>("Stackit.UnifiedFirewall.WriteRules");
