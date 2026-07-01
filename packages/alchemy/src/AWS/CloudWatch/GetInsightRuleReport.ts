import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InsightRule } from "./InsightRule.ts";

export interface GetInsightRuleReportRequest extends Omit<
  cloudwatch.GetInsightRuleReportInput,
  "RuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetInsightRuleReport`.
 * @binding
 */
export interface GetInsightRuleReport extends Binding.Service<
  GetInsightRuleReport,
  "AWS.CloudWatch.GetInsightRuleReport",
  (
    rule: InsightRule,
  ) => Effect.Effect<
    (
      request: GetInsightRuleReportRequest,
    ) => Effect.Effect<
      cloudwatch.GetInsightRuleReportOutput,
      cloudwatch.GetInsightRuleReportError
    >
  >
> {}

export const GetInsightRuleReport = Binding.Service<GetInsightRuleReport>(
  "AWS.CloudWatch.GetInsightRuleReport",
);
