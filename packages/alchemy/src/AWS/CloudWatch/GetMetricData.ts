import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricDataRequest extends cloudwatch.GetMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricData`.
 * @binding
 */
export interface GetMetricData extends Binding.Service<
  GetMetricData,
  "AWS.CloudWatch.GetMetricData",
  () => Effect.Effect<
    (
      request: GetMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricDataOutput,
      cloudwatch.GetMetricDataError
    >
  >
> {}

export const GetMetricData = Binding.Service<GetMetricData>(
  "AWS.CloudWatch.GetMetricData",
);
