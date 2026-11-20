import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface PutTelemetryRecordsRequest extends xray.PutTelemetryRecordsRequest {}

/**
 * Upload telemetry about segment transmission (received/sent/rejected
 * counts and backend connection errors) — the companion action to
 * `PutTraceSegments` used by X-Ray daemons and custom emitters.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.PutTelemetryRecordsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:PutTelemetryRecords`, so the binding grants it on `*`.
 * ### Writing Traces
 * **Example:** Report segment transmission telemetry
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:PutTelemetryRecords
 * const putTelemetryRecords = yield* XRay.PutTelemetryRecords();
 *
 * // runtime
 * yield* putTelemetryRecords({
 *   TelemetryRecords: [
 *     {
 *       Timestamp: new Date(),
 *       SegmentsReceivedCount: 10,
 *       SegmentsSentCount: 10,
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface PutTelemetryRecords extends Binding.Service<
  PutTelemetryRecords,
  "AWS.XRay.PutTelemetryRecords",
  () => Effect.Effect<
    (
      request: PutTelemetryRecordsRequest,
    ) => Effect.Effect<xray.PutTelemetryRecordsResult, xray.PutTelemetryRecordsError>
  >
> {}
export const PutTelemetryRecords = Binding.Service<PutTelemetryRecords>(
  "AWS.XRay.PutTelemetryRecords",
);

/**
 * HTTP implementation of the `XRay.PutTelemetryRecords` binding.
 *
 * At deploy time it grants `xray:PutTelemetryRecords` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const putTelemetryRecords = yield* XRay.PutTelemetryRecords();
 *   // ...
 * }).pipe(Effect.provide(XRay.PutTelemetryRecordsHttp));
 * ```
 */
export const PutTelemetryRecordsHttp = Layer.effect(
  PutTelemetryRecords,
  makeXRayHttpBinding({
    tag: "AWS.XRay.PutTelemetryRecords",
    operation: xray.putTelemetryRecords,
    actions: ["xray:PutTelemetryRecords"],
  }),
);
