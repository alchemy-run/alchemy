import * as xray from "@distilled.cloud/aws/xray";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

export interface GetSamplingRulesRequest extends xray.GetSamplingRulesRequest {}

/**
 * Retrieve all X-Ray sampling rules — the first half of the sampling
 * protocol used by custom samplers (poll rules, then report statistics
 * via `GetSamplingTargets`).
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingRulesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingRules`, so the binding grants it on `*`.
 * ### Sampling
 * **Example:** Poll the active sampling rules
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * // init — grants xray:GetSamplingRules
 * const getSamplingRules = yield* XRay.GetSamplingRules();
 *
 * // runtime
 * const rules = yield* getSamplingRules();
 * const names = (rules.SamplingRuleRecords ?? []).map(
 *   (record) => record.SamplingRule?.RuleName,
 * );
 * ```
 *
 * @binding
 */
export interface GetSamplingRules extends Binding.Service<
  GetSamplingRules,
  "AWS.XRay.GetSamplingRules",
  () => Effect.Effect<
    (
      request?: GetSamplingRulesRequest,
    ) => Effect.Effect<xray.GetSamplingRulesResult, xray.GetSamplingRulesError>
  >
> {}
export const GetSamplingRules = Binding.Service<GetSamplingRules>("AWS.XRay.GetSamplingRules");

/**
 * HTTP implementation of the `XRay.GetSamplingRules` binding.
 *
 * At deploy time it grants `xray:GetSamplingRules` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "@alchemy.run/aws/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingRules = yield* XRay.GetSamplingRules();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingRulesHttp));
 * ```
 */
export const GetSamplingRulesHttp = Layer.effect(
  GetSamplingRules,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingRules",
    operation: xray.getSamplingRules,
    actions: ["xray:GetSamplingRules"],
  }),
);
