import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetSamplingTargetsRequest extends xray.GetSamplingTargetsRequest {}

/**
 * Report sampling statistics and receive updated sampling quotas — the
 * second half of the sampling protocol implemented by X-Ray SDK samplers.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingTargetsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingTargets`, so the binding grants it on `*`.
 * ### Sampling
 * **Example:** Refresh sampling quotas
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetSamplingTargets
 * const getSamplingTargets = yield* XRay.GetSamplingTargets();
 *
 * // runtime — report what this client sampled and receive new quotas
 * const targets = yield* getSamplingTargets({
 *   SamplingStatisticsDocuments: [
 *     {
 *       RuleName: "my-rule",
 *       ClientID: "0123456789abcdef01234567",
 *       Timestamp: new Date(),
 *       RequestCount: 100,
 *       SampledCount: 5,
 *     },
 *   ],
 * });
 * const documents = targets.SamplingTargetDocuments ?? [];
 * ```
 *
 * @binding
 */
export interface GetSamplingTargets extends Binding.Service<
  GetSamplingTargets,
  "AWS.XRay.GetSamplingTargets",
  () => Effect.Effect<
    (
      request: GetSamplingTargetsRequest,
    ) => Effect.Effect<xray.GetSamplingTargetsResult, xray.GetSamplingTargetsError>
  >
> {}
export const GetSamplingTargets = Binding.Service<GetSamplingTargets>(
  "AWS.XRay.GetSamplingTargets",
);

/**
 * HTTP implementation of the `XRay.GetSamplingTargets` binding.
 *
 * At deploy time it grants `xray:GetSamplingTargets` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingTargets = yield* XRay.GetSamplingTargets();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingTargetsHttp));
 * ```
 */
export const GetSamplingTargetsHttp = Layer.effect(
  GetSamplingTargets,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingTargets",
    operation: xray.getSamplingTargets,
    actions: ["xray:GetSamplingTargets"],
  }),
);
