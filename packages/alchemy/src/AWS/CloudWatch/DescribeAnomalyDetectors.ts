import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAnomalyDetectorsRequest
  extends cloudwatch.DescribeAnomalyDetectorsInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAnomalyDetectors`.
 * @binding
 */
export interface DescribeAnomalyDetectors extends Binding.Service<
  DescribeAnomalyDetectors,
  "AWS.CloudWatch.DescribeAnomalyDetectors",
  () => Effect.Effect<
    (
      request?: DescribeAnomalyDetectorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAnomalyDetectorsOutput,
      cloudwatch.DescribeAnomalyDetectorsError
    >
  >
> {}

export const DescribeAnomalyDetectors =
  Binding.Service<DescribeAnomalyDetectors>(
    "AWS.CloudWatch.DescribeAnomalyDetectors",
  );
