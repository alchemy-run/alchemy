import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRuleSetHttpBinding } from "./BindingHttp.ts";
import type { RuleSet } from "./RuleSet.ts";

export interface GetRuleSetRequest extends Omit<cw.GetProjectsLocationsRuleSetsRequest, "name"> {}

/**
 * Runtime binding for Document AI Warehouse `ruleSets.get`.
 *
 * Grants `roles/contentwarehouse.admin` on the project because
 * `contentwarehouse.ruleSets.get` is only in that role and Document AI
 * Warehouse has no per-resource IAM.
 *
 * Bind this operation to a {@link RuleSet} in a Function/Action init
 * phase. Provide {@link GetRuleSetHttp}.
 *
 * ### Reading Rule Sets
 * **Example:** Read the bound rule set
 * ```typescript
 * const getRuleSet = yield* GCP.ContentWarehouse.GetRuleSet(rules);
 * const live = yield* getRuleSet();
 * ```
 *
 * @binding
 * @category ContentWarehouse
 */
export interface GetRuleSet extends Binding.Service<
  GetRuleSet,
  "GCP.ContentWarehouse.GetRuleSet",
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

export const GetRuleSet = Binding.Service<GetRuleSet>("GCP.ContentWarehouse.GetRuleSet");

/**
 * HTTP implementation of {@link GetRuleSet}.
 *
 * Grants `roles/contentwarehouse.admin` on the project because
 * `contentwarehouse.ruleSets.get` is in no narrower predefined role.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetRuleSet
 */
export const GetRuleSetHttp = Layer.effect(
  GetRuleSet,
  makeRuleSetHttpBinding({
    tag: "GCP.ContentWarehouse.GetRuleSet",
    operation: cw.getProjectsLocationsRuleSets,
    // contentwarehouse.ruleSets.get is only in contentwarehouse.admin.
    iam: { role: "roles/contentwarehouse.admin" },
  }),
);
