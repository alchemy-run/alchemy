import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetSamplingStatisticSummariesRequest
  extends xray.GetSamplingStatisticSummariesRequest {}

/**
 * Retrieve recent aggregate sampling results (requests matched, sampled,
 * and borrowed) for every sampling rule.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingStatisticSummariesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingStatisticSummaries`, so the binding grants it on `*`.
 * ### Sampling
 * **Example:** Inspect recent sampling activity
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetSamplingStatisticSummaries
 * const getSamplingStatisticSummaries =
 *   yield* XRay.GetSamplingStatisticSummaries();
 *
 * // runtime
 * const summaries = yield* getSamplingStatisticSummaries();
 * const perRule = summaries.SamplingStatisticSummaries ?? [];
 * ```
 *
 * @binding
 */
export interface GetSamplingStatisticSummaries extends Binding.Service<
  GetSamplingStatisticSummaries,
  "AWS.XRay.GetSamplingStatisticSummaries",
  () => Effect.Effect<
    (
      request?: GetSamplingStatisticSummariesRequest,
    ) => Effect.Effect<
      xray.GetSamplingStatisticSummariesResult,
      xray.GetSamplingStatisticSummariesError
    >
  >
> {}
export const GetSamplingStatisticSummaries = Binding.Service<GetSamplingStatisticSummaries>(
  "AWS.XRay.GetSamplingStatisticSummaries",
);

/**
 * HTTP implementation of the `XRay.GetSamplingStatisticSummaries` binding.
 *
 * At deploy time it grants `xray:GetSamplingStatisticSummaries` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingStatisticSummaries = yield* XRay.GetSamplingStatisticSummaries();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingStatisticSummariesHttp));
 * ```
 */
export const GetSamplingStatisticSummariesHttp = Layer.effect(
  GetSamplingStatisticSummaries,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingStatisticSummaries",
    operation: xray.getSamplingStatisticSummaries,
    actions: ["xray:GetSamplingStatisticSummaries"],
  }),
);
