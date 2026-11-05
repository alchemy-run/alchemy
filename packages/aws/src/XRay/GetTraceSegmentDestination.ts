import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetTraceSegmentDestinationRequest extends xray.GetTraceSegmentDestinationRequest {}

/**
 * Retrieve the current destination (X-Ray or CloudWatch Logs) of data
 * sent to `PutTraceSegments` and the OTLP endpoint. Transaction Search
 * trace retrieval requires a CloudWatch Logs destination.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetTraceSegmentDestinationHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetTraceSegmentDestination`, so the binding grants it on `*`.
 * ### Transaction Search
 * **Example:** Check the trace segment destination
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetTraceSegmentDestination
 * const getTraceSegmentDestination =
 *   yield* XRay.GetTraceSegmentDestination();
 *
 * // runtime
 * const destination = yield* getTraceSegmentDestination();
 * const isTransactionSearch = destination.Destination === "CloudWatchLogs";
 * ```
 *
 * @binding
 */
export interface GetTraceSegmentDestination extends Binding.Service<
  GetTraceSegmentDestination,
  "AWS.XRay.GetTraceSegmentDestination",
  () => Effect.Effect<
    (
      request?: GetTraceSegmentDestinationRequest,
    ) => Effect.Effect<xray.GetTraceSegmentDestinationResult, xray.GetTraceSegmentDestinationError>
  >
> {}
export const GetTraceSegmentDestination = Binding.Service<GetTraceSegmentDestination>(
  "AWS.XRay.GetTraceSegmentDestination",
);

/**
 * HTTP implementation of the `XRay.GetTraceSegmentDestination` binding.
 *
 * At deploy time it grants `xray:GetTraceSegmentDestination` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getTraceSegmentDestination = yield* XRay.GetTraceSegmentDestination();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTraceSegmentDestinationHttp));
 * ```
 */
export const GetTraceSegmentDestinationHttp = Layer.effect(
  GetTraceSegmentDestination,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTraceSegmentDestination",
    operation: xray.getTraceSegmentDestination,
    actions: ["xray:GetTraceSegmentDestination"],
  }),
);
