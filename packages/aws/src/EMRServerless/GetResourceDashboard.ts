import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";

/**
 * Request accepted by the {@link GetResourceDashboard} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type GetResourceDashboardInput = Omit<emr.GetResourceDashboardRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:GetResourceDashboard`.
 *
 * Creates a pre-signed dashboard URL for a specific resource (e.g. a
 * worker) of the bound {@link Application}. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.GetResourceDashboardHttp)`.
 * ### Dashboards
 * **Example:** Link To A Resource Dashboard
 * ```typescript
 * // init
 * const getResourceDashboard =
 *   yield* AWS.EMRServerless.GetResourceDashboard(app);
 *
 * // runtime
 * const { url } = yield* getResourceDashboard({ resourceId, resourceType });
 * ```
 *
 * @binding
 */
export interface GetResourceDashboard extends Binding.Service<
  GetResourceDashboard,
  "AWS.EMRServerless.GetResourceDashboard",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetResourceDashboardInput,
    ) => Effect.Effect<emr.GetResourceDashboardResponse, emr.GetResourceDashboardError>
  >
> {}
export const GetResourceDashboard = Binding.Service<GetResourceDashboard>(
  "AWS.EMRServerless.GetResourceDashboard",
);

export const GetResourceDashboardHttp = Layer.effect(
  GetResourceDashboard,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetResourceDashboard",
    operation: emr.getResourceDashboard,
    actions: ["emr-serverless:GetResourceDashboard"],
    // The dashboard is minted for a sub-resource (e.g. a session) of the
    // application — grant the sub-resource wildcard alongside the
    // application ARN. NOTE: as of 2026-07 the service denies this action
    // for every caller (even `Action:"*"` admins) — see
    // test/AWS/EMRServerless/probe.test.ts, which pins that platform gate.
    subresources: ["/*"],
  }),
);
