import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MetricStream } from "./MetricStream.ts";

export interface GetMetricStreamRequest extends Omit<
  cloudwatch.GetMetricStreamInput,
  "Name"
> {}

/**
 * Runtime binding for `cloudwatch:GetMetricStream`.
 * @binding
 */
export interface GetMetricStream extends Binding.Service<
  GetMetricStream,
  "AWS.CloudWatch.GetMetricStream",
  (
    metricStream: MetricStream,
  ) => Effect.Effect<
    (
      request?: GetMetricStreamRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStreamOutput,
      cloudwatch.GetMetricStreamError
    >
  >
> {}

export const GetMetricStream = Binding.Service<GetMetricStream>(
  "AWS.CloudWatch.GetMetricStream",
);
