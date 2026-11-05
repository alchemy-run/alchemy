import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetInsightImpactGraphRequest extends xray.GetInsightImpactGraphRequest {}

/**
 * Retrieve a structural service graph filtered by insight — which
 * services the insight's anomaly impacted over a time window.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightImpactGraphHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsightImpactGraph`, so the binding grants it on `*`.
 * ### Insights
 * **Example:** Graph the services an insight impacted
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetInsightImpactGraph
 * const getInsightImpactGraph = yield* XRay.GetInsightImpactGraph();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const graph = yield* getInsightImpactGraph({
 *   InsightId: insightId,
 *   StartTime: new Date(now - 60 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const services = graph.Services ?? [];
 * ```
 *
 * @binding
 */
export interface GetInsightImpactGraph extends Binding.Service<
  GetInsightImpactGraph,
  "AWS.XRay.GetInsightImpactGraph",
  () => Effect.Effect<
    (
      request: GetInsightImpactGraphRequest,
    ) => Effect.Effect<xray.GetInsightImpactGraphResult, xray.GetInsightImpactGraphError>
  >
> {}
export const GetInsightImpactGraph = Binding.Service<GetInsightImpactGraph>(
  "AWS.XRay.GetInsightImpactGraph",
);

/**
 * HTTP implementation of the `XRay.GetInsightImpactGraph` binding.
 *
 * At deploy time it grants `xray:GetInsightImpactGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightImpactGraph = yield* XRay.GetInsightImpactGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightImpactGraphHttp));
 * ```
 */
export const GetInsightImpactGraphHttp = Layer.effect(
  GetInsightImpactGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightImpactGraph",
    operation: xray.getInsightImpactGraph,
    actions: ["xray:GetInsightImpactGraph"],
  }),
);
