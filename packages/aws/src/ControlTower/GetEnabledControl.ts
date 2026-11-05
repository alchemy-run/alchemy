import * as controltower from "@distilled.cloud/aws/controltower";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledControl } from "./EnabledControl.ts";

/**
 * Runtime binding for `controltower:GetEnabledControl`.
 *
 * Bind this operation to an {@link EnabledControl} to read the enablement's
 * live status, drift status, and parameters from inside a function runtime.
 * Useful for drift-monitoring functions that alert when a guardrail drifts.
 * Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetEnabledControlHttp)`.
 * ### Inspecting an Enabled Control
 * **Example:** Read the Enabled Control's Drift Status
 * ```typescript
 * // init — bind the operation to the enabled control
 * const getEnabledControl = yield* AWS.ControlTower.GetEnabledControl(guardrail);
 *
 * // runtime
 * const { enabledControlDetails } = yield* getEnabledControl();
 * console.log(enabledControlDetails.driftStatusSummary?.driftStatus);
 * ```
 *
 * @binding
 */
export interface GetEnabledControl extends Binding.Service<
  GetEnabledControl,
  "AWS.ControlTower.GetEnabledControl",
  (
    enabledControl: EnabledControl,
  ) => Effect.Effect<
    () => Effect.Effect<controltower.GetEnabledControlOutput, controltower.GetEnabledControlError>
  >
> {}

export const GetEnabledControl = Binding.Service<GetEnabledControl>(
  "AWS.ControlTower.GetEnabledControl",
);

export const GetEnabledControlHttp = Layer.effect(
  GetEnabledControl,
  makeControlTowerHttpBinding({
    capability: "GetEnabledControl",
    iamActions: ["controltower:GetEnabledControl"],
    requestKey: "enabledControlIdentifier",
    identifier: (enabledControl: EnabledControl) => enabledControl.enabledControlArn,
    operation: controltower.getEnabledControl,
  }),
);
