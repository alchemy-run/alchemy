import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

export interface GetDashboardRequest extends Omit<
  cloudwatch.GetDashboardInput,
  "DashboardName"
> {}

/**
 * Runtime binding for `cloudwatch:GetDashboard`.
 * @binding
 */
export interface GetDashboard extends Binding.Service<
  GetDashboard,
  "AWS.CloudWatch.GetDashboard",
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request?: GetDashboardRequest,
    ) => Effect.Effect<
      cloudwatch.GetDashboardOutput,
      cloudwatch.GetDashboardError
    >
  >
> {}

export const GetDashboard = Binding.Service<GetDashboard>(
  "AWS.CloudWatch.GetDashboard",
);
