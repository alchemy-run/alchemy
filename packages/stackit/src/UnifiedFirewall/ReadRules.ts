import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import type { GetRuleRequest } from "./GetRule.ts";
import type { ListRulesRequest } from "./ListRules.ts";

/** The read operations on the rules of a bound project and region. */
export interface ReadRulesClient {
  /** Read one rule by its id. */
  getRule(
    request: GetRuleRequest,
  ): Effect.Effect<ufw.RuleResponse, ufw.GetRuleError, RuntimeContext>;
  /** List the rules across products. Check `errors` on the response before trusting `rules`. */
  listRules(
    request?: ListRulesRequest,
  ): Effect.Effect<ufw.ListRulesResponse, ufw.ListRulesError, RuntimeContext>;
}

/**
 * Read the firewall rules of a project and region from a Function/Worker.
 *
 * Bind it in the init phase to any resource in that project and region (a {@link BindingScope})
 * and provide {@link ReadRulesHttp}. Its project and region are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.get` and `ufw.instance.list` on the project,
 * so it reaches every rule in that project: STACKIT binds roles on projects, folders and organizations, not on a single rule. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Auditing Rules
 * **Example:** Count the rules in `Error`
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
 *     const firewall = yield* Stackit.UnifiedFirewall.ReadRules(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rules } = yield* firewall.listRules();
 *         return yield* HttpServerResponse.json({ failed: rules.filter((rule) => rule.status === "Error").length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ReadRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ReadRules extends Binding.Service<
  ReadRules,
  "Stackit.UnifiedFirewall.ReadRules",
  (scope: BindingScope) => Effect.Effect<ReadRulesClient>
> {}

export const ReadRules = Binding.Service<ReadRules>("Stackit.UnifiedFirewall.ReadRules");
