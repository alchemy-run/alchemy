import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListManagedRuleSetsRequest extends Omit<
  waf.ListManagedRuleSetsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for WAF `ListManagedRuleSets`: list one page of the managed
 * rule sets in a project and region, without their rule inventory. Pass
 * `pageId` from a response's `nextPageId` to read the next page.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListManagedRuleSetsHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.mrs.list` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Listing Rule Sets
 * **Example:** List rule set names from a Cloudflare Worker
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
 *     const listManagedRuleSets = yield* Stackit.WAF.ListManagedRuleSets(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listManagedRuleSets({ pageSize: "50" });
 *         return yield* HttpServerResponse.json({
 *           names: (items ?? []).map((ruleSet) => ruleSet.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.ListManagedRuleSetsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface ListManagedRuleSets extends Binding.Service<
  ListManagedRuleSets,
  "Stackit.WAF.ListManagedRuleSets",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListManagedRuleSetsRequest,
    ) => Effect.Effect<waf.ListManagedRuleSetResponse, waf.ListManagedRuleSetsError, RuntimeContext>
  >
> {}

export const ListManagedRuleSets = Binding.Service<ListManagedRuleSets>(
  "Stackit.WAF.ListManagedRuleSets",
);
