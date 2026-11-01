import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListRulesRequest extends Omit<ufw.ListRulesRequest, "projectId" | "regionId"> {}

/**
 * Runtime binding for Unified Firewall `listRules`: list the rules of a project and region across products, including rules that other products wrote and rules not in this stack. Check `errors` on the response before treating `rules` as complete. The response has no cursor, so `cursor` can't be followed from it.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such
 * as a `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init
 * phase and provide {@link ListRulesHttp}. Its project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.list` on the project, so it reaches every rule in
 * that project: STACKIT binds roles on projects, folders and organizations, not on a single rule.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Auditing Rules
 * **Example:** List the ingress rules of a project
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
 *     const listRules = yield* Stackit.UnifiedFirewall.ListRules(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rules, errors } = yield* listRules({ direction: "ingress" });
 *         return yield* HttpServerResponse.json({ rules: rules.length, errors });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ListRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ListRules extends Binding.Service<
  ListRules,
  "Stackit.UnifiedFirewall.ListRules",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListRulesRequest,
    ) => Effect.Effect<ufw.ListRulesResponse, ufw.ListRulesError, RuntimeContext>
  >
> {}

export const ListRules = Binding.Service<ListRules>("Stackit.UnifiedFirewall.ListRules");
