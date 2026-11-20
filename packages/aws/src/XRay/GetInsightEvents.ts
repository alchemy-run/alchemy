import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetInsightEventsRequest extends xray.GetInsightEventsRequest {}

/**
 * Retrieve the intermediate states (events) X-Ray recorded while
 * re-evaluating an insight — the insight's impact timeline.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightEventsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsightEvents`, so the binding grants it on `*`.
 * ### Insights
 * **Example:** Walk an insight's impact timeline
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetInsightEvents
 * const getInsightEvents = yield* XRay.GetInsightEvents();
 *
 * // runtime
 * const result = yield* getInsightEvents({ InsightId: insightId });
 * const timeline = result.InsightEvents ?? [];
 * ```
 *
 * @binding
 */
export interface GetInsightEvents extends Binding.Service<
  GetInsightEvents,
  "AWS.XRay.GetInsightEvents",
  () => Effect.Effect<
    (
      request: GetInsightEventsRequest,
    ) => Effect.Effect<xray.GetInsightEventsResult, xray.GetInsightEventsError>
  >
> {}
export const GetInsightEvents = Binding.Service<GetInsightEvents>("AWS.XRay.GetInsightEvents");

/**
 * HTTP implementation of the `XRay.GetInsightEvents` binding.
 *
 * At deploy time it grants `xray:GetInsightEvents` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightEvents = yield* XRay.GetInsightEvents();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightEventsHttp));
 * ```
 */
export const GetInsightEventsHttp = Layer.effect(
  GetInsightEvents,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightEvents",
    operation: xray.getInsightEvents,
    actions: ["xray:GetInsightEvents"],
  }),
);
