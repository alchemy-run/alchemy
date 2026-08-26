import type * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { RuleSet } from "./RuleSet.ts";

export interface GetRuleSetRequest extends Omit<
  cw.GetProjectsLocationsRuleSetsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI Warehouse `ruleSets.get`.
 *
 * Bind this operation to a {@link RuleSet} in a Function/Action init
 * phase. Provide {@link GetRuleSetHttp}.
 *
 * ### Reading Rule Sets
 * **Example:** Read the bound rule set
 * ```typescript
 * const getRuleSet = yield* GCP.Contentwarehouse.GetRuleSet(rules);
 * const live = yield* getRuleSet();
 * ```
 *
 * @binding
 * @product GCP
 * @category Contentwarehouse
 */
export interface GetRuleSet extends Binding.Service<
  GetRuleSet,
  "GCP.Contentwarehouse.GetRuleSet",
  (
    ruleSet: RuleSet,
  ) => Effect.Effect<
    (
      request?: GetRuleSetRequest,
    ) => Effect.Effect<
      cw.GoogleCloudContentwarehouseV1RuleSet,
      cw.GetProjectsLocationsRuleSetsError,
      RuntimeContext
    >
  >
> {}

export const GetRuleSet = Binding.Service<GetRuleSet>(
  "GCP.Contentwarehouse.GetRuleSet",
);
