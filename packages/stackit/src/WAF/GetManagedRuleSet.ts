import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedRuleSet } from "./ManagedRuleSet.ts";

/**
 * Runtime binding for WAF `GetManagedRuleSet`: read a managed rule set's
 * version and its inventory of rules with their current modes.
 *
 * Bind this operation to a {@link ManagedRuleSet} in a Function/Worker init
 * phase and provide {@link GetManagedRuleSetHttp}. The rule set's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.mrs.get` on the project holding
 * the rule set, so it reaches every rule set in that project: STACKIT binds
 * roles on projects, folders and organizations, not on a single rule set. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Rule Set
 * **Example:** Report the version from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Owasp = Stackit.WAF.ManagedRuleSet("Owasp", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getManagedRuleSet = yield* Stackit.WAF.GetManagedRuleSet(yield* Owasp);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getManagedRuleSet();
 *         return yield* HttpServerResponse.json({
 *           version: live.version,
 *           groups: Object.keys(live.groups ?? {}),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.GetManagedRuleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface GetManagedRuleSet extends Binding.Service<
  GetManagedRuleSet,
  "Stackit.WAF.GetManagedRuleSet",
  (
    ruleSet: ManagedRuleSet,
  ) => Effect.Effect<
    () => Effect.Effect<waf.GetManagedRuleSetResponse, waf.GetManagedRuleSetError, RuntimeContext>
  >
> {}

export const GetManagedRuleSet = Binding.Service<GetManagedRuleSet>(
  "Stackit.WAF.GetManagedRuleSet",
);
