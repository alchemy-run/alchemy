import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ManagedRuleSet } from "./ManagedRuleSet.ts";

export interface PatchManagedRuleSetRequest extends Omit<
  waf.PatchManagedRuleSetRequest,
  "projectId" | "region" | "name"
> {}

/**
 * Runtime binding for WAF `PatchManagedRuleSet`: set the mode of individual
 * managed rules from deployed code, for example to quiet a false positive.
 * Only the rules in the request change.
 *
 * A mode set this way on a rule the {@link ManagedRuleSet} declares in
 * `groups` is set back by the next update of that resource. Rules it doesn't
 * declare are left as they are.
 *
 * Bind this operation to a {@link ManagedRuleSet} in a Function/Worker init
 * phase and provide {@link PatchManagedRuleSetHttp}. The rule set's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.mrs.update` on the project
 * holding the rule set, so it reaches every rule set in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single rule
 * set. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Tuning Rules
 * **Example:** Switch a rule to log-only from a Cloudflare Worker
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
 *     const patchManagedRuleSet = yield* Stackit.WAF.PatchManagedRuleSet(yield* Owasp);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* patchManagedRuleSet({
 *           groups: { "942": { rules: { "942100": { mode: "MODE_LOG_ONLY" } } } },
 *         });
 *         return HttpServerResponse.text("patched");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.PatchManagedRuleSetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface PatchManagedRuleSet extends Binding.Service<
  PatchManagedRuleSet,
  "Stackit.WAF.PatchManagedRuleSet",
  (
    ruleSet: ManagedRuleSet,
  ) => Effect.Effect<
    (
      request: PatchManagedRuleSetRequest,
    ) => Effect.Effect<waf.GetManagedRuleSetResponse, waf.PatchManagedRuleSetError, RuntimeContext>
  >
> {}

export const PatchManagedRuleSet = Binding.Service<PatchManagedRuleSet>(
  "Stackit.WAF.PatchManagedRuleSet",
);
