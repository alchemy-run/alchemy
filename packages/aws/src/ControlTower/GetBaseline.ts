import * as controltower from "@distilled.cloud/aws/controltower";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `controltower:GetBaseline`.
 *
 * An account-level operation that reads one entry of the Control Tower
 * baseline catalog by its ARN — its name and description. Provide the
 * implementation with `Effect.provide(AWS.ControlTower.GetBaselineHttp)`.
 * ### Browsing the Baseline Catalog
 * **Example:** Read a Baseline's Details
 * ```typescript
 * // init — account-level binding takes no resource
 * const getBaseline = yield* AWS.ControlTower.GetBaseline();
 *
 * // runtime
 * const baseline = yield* getBaseline({ baselineIdentifier: baselineArn });
 * console.log(baseline.name, baseline.description);
 * ```
 *
 * @binding
 */
export interface GetBaseline extends Binding.Service<
  GetBaseline,
  "AWS.ControlTower.GetBaseline",
  () => Effect.Effect<
    (
      request: controltower.GetBaselineInput,
    ) => Effect.Effect<controltower.GetBaselineOutput, controltower.GetBaselineError>
  >
> {}

export const GetBaseline = Binding.Service<GetBaseline>("AWS.ControlTower.GetBaseline");

export const GetBaselineHttp = Layer.effect(
  GetBaseline,
  makeControlTowerAccountHttpBinding({
    capability: "GetBaseline",
    iamActions: ["controltower:GetBaseline"],
    operation: controltower.getBaseline,
  }),
);
