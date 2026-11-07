import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetInsightSummariesRequest extends xray.GetInsightSummariesRequest {}

/**
 * Retrieve the summaries of all insights in a group (by name or ARN)
 * matching the provided state and time filters.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetInsightSummariesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetInsightSummaries`, so the binding grants it on `*`.
 * ### Insights
 * **Example:** List recent insights for a group
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetInsightSummaries
 * const getInsightSummaries = yield* XRay.GetInsightSummaries();
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const result = yield* getInsightSummaries({
 *   GroupName: group.groupName,
 *   StartTime: new Date(now - 24 * 60 * 60 * 1000),
 *   EndTime: new Date(now),
 * });
 * const insights = result.InsightSummaries ?? [];
 * ```
 *
 * @binding
 */
export interface GetInsightSummaries extends Binding.Service<
  GetInsightSummaries,
  "AWS.XRay.GetInsightSummaries",
  () => Effect.Effect<
    (
      request: GetInsightSummariesRequest,
    ) => Effect.Effect<xray.GetInsightSummariesResult, xray.GetInsightSummariesError>
  >
> {}
export const GetInsightSummaries = Binding.Service<GetInsightSummaries>(
  "AWS.XRay.GetInsightSummaries",
);

/**
 * HTTP implementation of the `XRay.GetInsightSummaries` binding.
 *
 * At deploy time it grants `xray:GetInsightSummaries` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightSummaries = yield* XRay.GetInsightSummaries();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightSummariesHttp));
 * ```
 */
export const GetInsightSummariesHttp = Layer.effect(
  GetInsightSummaries,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightSummaries",
    operation: xray.getInsightSummaries,
    actions: ["xray:GetInsightSummaries"],
  }),
);
