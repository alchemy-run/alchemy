import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutMetricDataRequest extends cloudwatch.PutMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:PutMetricData`.
 * @binding
 */
export interface PutMetricData extends Binding.Service<
  PutMetricData,
  "AWS.CloudWatch.PutMetricData",
  () => Effect.Effect<
    (
      request: PutMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.PutMetricDataResponse,
      cloudwatch.PutMetricDataError
    >
  >
> {}

export const PutMetricData = Binding.Service<PutMetricData>(
  "AWS.CloudWatch.PutMetricData",
);
