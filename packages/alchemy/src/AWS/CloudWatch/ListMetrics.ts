import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListMetricsRequest extends cloudwatch.ListMetricsInput {}

/**
 * Runtime binding for `cloudwatch:ListMetrics`.
 * @binding
 */
export interface ListMetrics extends Binding.Service<
  ListMetrics,
  "AWS.CloudWatch.ListMetrics",
  () => Effect.Effect<
    (
      request?: ListMetricsRequest,
    ) => Effect.Effect<
      cloudwatch.ListMetricsOutput,
      cloudwatch.ListMetricsError
    >
  >
> {}

export const ListMetrics = Binding.Service<ListMetrics>(
  "AWS.CloudWatch.ListMetrics",
);
