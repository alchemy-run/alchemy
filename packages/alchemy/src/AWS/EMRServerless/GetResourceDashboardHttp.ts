import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { GetResourceDashboard } from "./GetResourceDashboard.ts";

export const GetResourceDashboardHttp = Layer.effect(
  GetResourceDashboard,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetResourceDashboard",
    operation: emr.getResourceDashboard,
    actions: ["emr-serverless:GetResourceDashboard"],
    // The dashboard is minted for a sub-resource (e.g. a worker) of the
    // application — the service authorizes against the sub-resource ARN
    // below the application, not the application ARN itself.
    subresources: ["/*"],
  }),
);
