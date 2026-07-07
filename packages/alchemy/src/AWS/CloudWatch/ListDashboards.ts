import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListDashboardsRequest extends cloudwatch.ListDashboardsInput {}

/**
 * Runtime binding for `cloudwatch:ListDashboards`.
 * @binding
 */
export interface ListDashboards extends Binding.Service<
  ListDashboards,
  "AWS.CloudWatch.ListDashboards",
  () => Effect.Effect<
    (
      request?: ListDashboardsRequest,
    ) => Effect.Effect<
      cloudwatch.ListDashboardsOutput,
      cloudwatch.ListDashboardsError
    >
  >
> {}

export const ListDashboards = Binding.Service<ListDashboards>(
  "AWS.CloudWatch.ListDashboards",
);
