import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAlarmHistoryRequest
  extends cloudwatch.DescribeAlarmHistoryInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmHistory`.
 * @binding
 */
export interface DescribeAlarmHistory extends Binding.Service<
  DescribeAlarmHistory,
  "AWS.CloudWatch.DescribeAlarmHistory",
  () => Effect.Effect<
    (
      request?: DescribeAlarmHistoryRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmHistoryOutput,
      cloudwatch.DescribeAlarmHistoryError
    >
  >
> {}

export const DescribeAlarmHistory = Binding.Service<DescribeAlarmHistory>(
  "AWS.CloudWatch.DescribeAlarmHistory",
);
