import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAlarmsForMetricRequest
  extends cloudwatch.DescribeAlarmsForMetricInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmsForMetric`.
 * @binding
 */
export interface DescribeAlarmsForMetric extends Binding.Service<
  DescribeAlarmsForMetric,
  "AWS.CloudWatch.DescribeAlarmsForMetric",
  () => Effect.Effect<
    (
      request: DescribeAlarmsForMetricRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmsForMetricOutput,
      cloudwatch.DescribeAlarmsForMetricError
    >
  >
> {}

export const DescribeAlarmsForMetric = Binding.Service<DescribeAlarmsForMetric>(
  "AWS.CloudWatch.DescribeAlarmsForMetric",
);
