import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface BatchGetTracesRequest extends xray.BatchGetTracesRequest {}

/**
 * Retrieve full traces (all segment documents) for a list of trace IDs
 * returned by `GetTraceSummaries`.
 *
 * X-Ray trace reads are account-scoped: IAM does not support resource-level
 * permissions for `xray:BatchGetTraces`, so the binding grants the action on
 * `*`.
 * @binding
 * @section Reading Traces
 * @example Fetch full traces by ID
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init
 * const batchGetTraces = yield* XRay.BatchGetTraces();
 *
 * // runtime
 * const traces = yield* batchGetTraces({
 *   TraceIds: ["1-63a2090f-3f4da4bcd9b1a3e07531423b"],
 * });
 * ```
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
export const BatchGetTraces = Binding.Service<BatchGetTraces>(
  "AWS.XRay.BatchGetTraces",
);
