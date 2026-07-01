import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetMetricWidgetImageRequest
  extends cloudwatch.GetMetricWidgetImageInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricWidgetImage`.
 * @binding
 */
export interface GetMetricWidgetImage extends Binding.Service<
  GetMetricWidgetImage,
  "AWS.CloudWatch.GetMetricWidgetImage",
  () => Effect.Effect<
    (
      request: GetMetricWidgetImageRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricWidgetImageOutput,
      cloudwatch.GetMetricWidgetImageError
    >
  >
> {}

export const GetMetricWidgetImage = Binding.Service<GetMetricWidgetImage>(
  "AWS.CloudWatch.GetMetricWidgetImage",
);
