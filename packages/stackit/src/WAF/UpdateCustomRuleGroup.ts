import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CustomRuleGroup } from "./CustomRuleGroup.ts";

export interface UpdateCustomRuleGroupRequest extends Omit<
  waf.UpdateCustomRuleGroupRequest,
  "projectId" | "region" | "name"
> {}

/**
 * Runtime binding for WAF `UpdateCustomRuleGroup`: replace a custom rule
 * group's rules from deployed code, for example to keep a block list current.
 * Send the complete rule set: STACKIT doesn't merge per rule.
 *
 * Rules set this way drift from the {@link CustomRuleGroup}'s props: the next
 * update of that resource sends the declared rules. A deploy that leaves the
 * props unchanged doesn't touch them.
 *
 * Bind this operation to a {@link CustomRuleGroup} in a Function/Worker init
 * phase and provide {@link UpdateCustomRuleGroupHttp}. The rule group's
 * project, region and name are injected into each request. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role holding only `alb.waf.crg.update` on the project
 * holding the rule group, so it reaches every rule group in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * rule group. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Updating a Rule Group
 * **Example:** Replace the rules from a Cloudflare Worker
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
 *     const updateCustomRuleGroup = yield* Stackit.WAF.UpdateCustomRuleGroup(yield* Blocks);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateCustomRuleGroup({
 *           rules: [
 *             {
 *               behavior: { action: "ACTION_DENY" },
 *               conditions: [
 *                 {
 *                   variable: { type: "VARIABLE_REQUEST_URI_RAW" },
 *                   operator: { type: "OPERATOR_BEGINS_WITH", value: "/debug" },
 *                 },
 *               ],
 *             },
 *           ],
 *         });
 *         return yield* HttpServerResponse.json({ rules: live.rules.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.UpdateCustomRuleGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface UpdateCustomRuleGroup extends Binding.Service<
  UpdateCustomRuleGroup,
  "Stackit.WAF.UpdateCustomRuleGroup",
  (
    group: CustomRuleGroup,
  ) => Effect.Effect<
    (
      request: UpdateCustomRuleGroupRequest,
    ) => Effect.Effect<
      waf.GetCustomRuleGroupResponse,
      waf.UpdateCustomRuleGroupError,
      RuntimeContext
    >
  >
> {}

export const UpdateCustomRuleGroup = Binding.Service<UpdateCustomRuleGroup>(
  "Stackit.WAF.UpdateCustomRuleGroup",
);
