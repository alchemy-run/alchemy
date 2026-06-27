import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricStatisticsRequest
  extends cloudwatch.GetMetricStatisticsInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricStatistics`.
 * @binding
 */
export interface GetMetricStatistics extends Binding.Service<
  GetMetricStatistics,
  "AWS.CloudWatch.GetMetricStatistics",
  () => Effect.Effect<
    (
      request: GetMetricStatisticsRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStatisticsOutput,
      cloudwatch.GetMetricStatisticsError
    >
  >
> {}

export const GetMetricStatistics = Binding.Service<GetMetricStatistics>(
  "AWS.CloudWatch.GetMetricStatistics",
);
