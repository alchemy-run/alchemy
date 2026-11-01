import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListCustomRuleGroupsRequest extends Omit<
  waf.ListCustomRuleGroupRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for WAF `ListCustomRuleGroup`: list one page of the custom
 * rule groups in a project and region. Pass `pageId` from a response's
 * `nextPageId` to read the next page.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListCustomRuleGroupsHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.crg.list` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Listing Rule Groups
 * **Example:** List rule group names from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Network = Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listCustomRuleGroups = yield* Stackit.WAF.ListCustomRuleGroups(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listCustomRuleGroups({ pageSize: "50" });
 *         return yield* HttpServerResponse.json({
 *           names: (items ?? []).map((group) => group.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.ListCustomRuleGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface ListCustomRuleGroups extends Binding.Service<
  ListCustomRuleGroups,
  "Stackit.WAF.ListCustomRuleGroups",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListCustomRuleGroupsRequest,
    ) => Effect.Effect<
      waf.ListCustomRuleGroupResponse,
      waf.ListCustomRuleGroupError,
      RuntimeContext
    >
  >
> {}

export const ListCustomRuleGroups = Binding.Service<ListCustomRuleGroups>(
  "Stackit.WAF.ListCustomRuleGroups",
);
