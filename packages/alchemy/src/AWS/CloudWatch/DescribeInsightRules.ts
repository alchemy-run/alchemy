import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeInsightRulesRequest
  extends cloudwatch.DescribeInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:DescribeInsightRules`.
 * @binding
 */
export interface DescribeInsightRules extends Binding.Service<
  DescribeInsightRules,
  "AWS.CloudWatch.DescribeInsightRules",
  () => Effect.Effect<
    (
      request?: DescribeInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeInsightRulesOutput,
      cloudwatch.DescribeInsightRulesError
    >
  >
> {}

export const DescribeInsightRules = Binding.Service<DescribeInsightRules>(
  "AWS.CloudWatch.DescribeInsightRules",
);
