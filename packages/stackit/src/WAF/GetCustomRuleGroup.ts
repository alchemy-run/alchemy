import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CustomRuleGroup } from "./CustomRuleGroup.ts";

/**
 * Runtime binding for WAF `GetCustomRuleGroup`: read a custom rule group's
 * rules, with their allocated ids and computed severities, and which WAF
 * configurations use it.
 *
 * Bind this operation to a {@link CustomRuleGroup} in a Function/Worker init
 * phase and provide {@link GetCustomRuleGroupHttp}. The rule group's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.crg.get` on the project holding
 * the rule group, so it reaches every rule group in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single rule
 * group. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Rule Group
 * **Example:** Report rule ids from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Blocks = Stackit.WAF.CustomRuleGroup("Blocks", {
 *   rules: [
 *     {
 *       behavior: { action: "ACTION_DENY" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REQUEST_URI_RAW" },
 *           operator: { type: "OPERATOR_BEGINS_WITH", value: "/admin" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCustomRuleGroup = yield* Stackit.WAF.GetCustomRuleGroup(yield* Blocks);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getCustomRuleGroup();
 *         return yield* HttpServerResponse.json({
 *           ids: live.rules.map((rule) => rule.id),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.GetCustomRuleGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface GetCustomRuleGroup extends Binding.Service<
  GetCustomRuleGroup,
  "Stackit.WAF.GetCustomRuleGroup",
  (
    group: CustomRuleGroup,
  ) => Effect.Effect<
    () => Effect.Effect<waf.GetCustomRuleGroupResponse, waf.GetCustomRuleGroupError, RuntimeContext>
  >
> {}

export const GetCustomRuleGroup = Binding.Service<GetCustomRuleGroup>(
  "Stackit.WAF.GetCustomRuleGroup",
);
