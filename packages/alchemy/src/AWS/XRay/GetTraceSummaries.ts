import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetTraceSummariesRequest
  extends xray.GetTraceSummariesRequest {}

/**
 * Retrieve IDs and annotations for traces available in a time frame,
 * optionally filtered by an X-Ray filter expression.
 *
 * X-Ray trace reads are account-scoped: IAM does not support resource-level
 * permissions for `xray:GetTraceSummaries`, so the binding grants the action
 * on `*`.
 * @binding
 * @section Reading Trace Summaries
 * @example Find recent traces for a service
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init
 * const getTraceSummaries = yield* XRay.GetTraceSummaries();
 *
 * // runtime
 * const summaries = yield* getTraceSummaries({
 *   StartTime: new Date(Date.now() - 5 * 60 * 1000),
 *   EndTime: new Date(),
 *   FilterExpression: 'service("my-api")',
 * });
 * ```
 */
export interface GetTraceSummaries extends Binding.Service<
  GetTraceSummaries,
  "AWS.XRay.GetTraceSummaries",
  () => Effect.Effect<
    (
      request: GetTraceSummariesRequest,
    ) => Effect.Effect<
      xray.GetTraceSummariesResult,
      xray.GetTraceSummariesError
    >
  >
> {}
export const GetTraceSummaries = Binding.Service<GetTraceSummaries>(
  "AWS.XRay.GetTraceSummaries",
);
