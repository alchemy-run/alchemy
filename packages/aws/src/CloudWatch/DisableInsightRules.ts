import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { InsightRuleResource } from "./binding-common.ts";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];

/**
 * Runtime binding for `cloudwatch:DisableInsightRules` — pause data
 * collection for the bound Contributor Insights rules. Bind it to one or
 * more {@link InsightRule} resources; the rule names are injected
 * automatically.
 *
 * Provide `CloudWatch.DisableInsightRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * ### Managing Insight Rules
 * **Example:** Pause a Contributor Insights Rule
 * ```typescript
 * // init — grants cloudwatch:DisableInsightRules on the rule
 * const disableInsightRules = yield* AWS.CloudWatch.DisableInsightRules(rule);
 *
 * // runtime
 * const result = yield* disableInsightRules();
 * const failures = result.Failures ?? []; // empty on success
 * ```
 *
 * @binding
 */
export interface DisableInsightRules extends Binding.Service<
  DisableInsightRules,
  "AWS.CloudWatch.DisableInsightRules",
  (
    ...rules: InsightRules
  ) => Effect.Effect<() => Effect.Effect<cloudwatch.DisableInsightRulesOutput, any>>
> {}

export const DisableInsightRules = Binding.Service<DisableInsightRules>(
  "AWS.CloudWatch.DisableInsightRules",
);

export const DisableInsightRulesHttp = Layer.effect(
  DisableInsightRules,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.DisableInsightRules",
    operation: cloudwatch.disableInsightRules,
    action: "cloudwatch:DisableInsightRules",
    namesKey: "RuleNames",
    name: (rule: InsightRuleResource) => rule.ruleName,
    arn: (rule: InsightRuleResource) => rule.ruleArn,
  }),
);
