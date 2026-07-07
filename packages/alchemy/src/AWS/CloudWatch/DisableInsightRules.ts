import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InsightRuleResource } from "./binding-common.ts";

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];

/**
 * Runtime binding for `cloudwatch:DisableInsightRules`.
 * @binding
 */
export interface DisableInsightRules extends Binding.Service<
  DisableInsightRules,
  "AWS.CloudWatch.DisableInsightRules",
  (
    ...rules: InsightRules
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableInsightRulesOutput, any>
  >
> {}

export const DisableInsightRules = Binding.Service<DisableInsightRules>(
  "AWS.CloudWatch.DisableInsightRules",
);
