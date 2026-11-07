import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface BatchGetTracesRequest extends xray.BatchGetTracesRequest {}

/**
 * Retrieve full traces (all segment documents) for a list of trace IDs
 * returned by `GetTraceSummaries`.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.BatchGetTracesHttp)`.
 *
 * X-Ray trace reads are account-scoped: IAM does not support resource-level
 * permissions for `xray:BatchGetTraces`, so the binding grants the action on
 * `*`.
 * ### Reading Traces
 * **Example:** Fetch full traces from a Handler
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * export default MyFunction.make(
 *   { main: import.meta.url, functionUrl: true, tracing: "Active" },
 *   Effect.gen(function* () {
 *     // init — bind the operation (grants xray:BatchGetTraces)
 *     const batchGetTraces = yield* XRay.BatchGetTraces();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — fetch full segment documents by trace ID
 *         const result = yield* batchGetTraces({
 *           TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 *         });
 *         return yield* HttpServerResponse.json({
 *           segments: result.Traces?.[0]?.Segments?.length ?? 0,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(XRay.BatchGetTracesHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface BatchGetTraces extends Binding.Service<
  BatchGetTraces,
  "AWS.XRay.BatchGetTraces",
  () => Effect.Effect<
    (
      request: BatchGetTracesRequest,
    ) => Effect.Effect<xray.BatchGetTracesResult, xray.BatchGetTracesError>
  >
> {}
export const BatchGetTraces = Binding.Service<BatchGetTraces>("AWS.XRay.BatchGetTraces");

/**
 * HTTP implementation of the `XRay.BatchGetTraces` binding.
 *
 * At deploy time it grants `xray:BatchGetTraces` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const batchGetTraces = yield* XRay.BatchGetTraces();
 *   // ...
 * }).pipe(Effect.provide(XRay.BatchGetTracesHttp));
 * ```
 */
export const BatchGetTracesHttp = Layer.effect(
  BatchGetTraces,
  makeXRayHttpBinding({
    tag: "AWS.XRay.BatchGetTraces",
    operation: xray.batchGetTraces,
    actions: ["xray:BatchGetTraces"],
  }),
);
