import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Effect from "effect/Effect";

/**
 * Shared scaffolding of the Unified Firewall resources. Not exported from the namespace barrel.
 */

/** STACKIT's Go SDK waits up to this long for a rule to settle (`services/ufw/v1api/wait`). */
export const RULE_TIMEOUT = "5 minutes";

export interface RuleScope {
  readonly projectId: string;
  readonly region: string;
}

/** The API's path parameters for a scope: it calls the region `regionId`. */
export const ruleTarget = (scope: RuleScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** A rule, or `undefined` once `getRule` answers its documented "Rule not found". */
export const getRuleOrUndefined = (scope: RuleScope, ruleId: string) =>
  ufw
    .getRule({ ...ruleTarget(scope), ruleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
