import * as controltower from "@distilled.cloud/aws/controltower";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";

/**
 * Runtime binding for `controltower:GetEnabledBaseline`.
 *
 * Bind this operation to an {@link EnabledBaseline} to read the
 * enablement's live status, drift status, and parameters from inside a
 * function runtime. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetEnabledBaselineHttp)`.
 * ### Inspecting an Enabled Baseline
 * **Example:** Read the Enabled Baseline's Status
 * ```typescript
 * // init — bind the operation to the enabled baseline
 * const getEnabledBaseline = yield* AWS.ControlTower.GetEnabledBaseline(ouBaseline);
 *
 * // runtime
 * const { enabledBaselineDetails } = yield* getEnabledBaseline();
 * console.log(enabledBaselineDetails?.statusSummary.status);
 * ```
 *
 * @binding
 */
export interface GetEnabledBaseline extends Binding.Service<
  GetEnabledBaseline,
  "AWS.ControlTower.GetEnabledBaseline",
  (
    enabledBaseline: EnabledBaseline,
  ) => Effect.Effect<
    () => Effect.Effect<controltower.GetEnabledBaselineOutput, controltower.GetEnabledBaselineError>
  >
> {}

export const GetEnabledBaseline = Binding.Service<GetEnabledBaseline>(
  "AWS.ControlTower.GetEnabledBaseline",
);

export const GetEnabledBaselineHttp = Layer.effect(
  GetEnabledBaseline,
  makeControlTowerHttpBinding({
    capability: "GetEnabledBaseline",
    iamActions: ["controltower:GetEnabledBaseline"],
    requestKey: "enabledBaselineIdentifier",
    identifier: (enabledBaseline: EnabledBaseline) => enabledBaseline.enabledBaselineArn,
    operation: controltower.getEnabledBaseline,
  }),
);
