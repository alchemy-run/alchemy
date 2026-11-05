import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `securityhub:UpdateStandardsControl`.
 *
 * Enables or disables an individual control within an enabled standard.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.UpdateStandardsControlHttp)`.
 * ### Standards & Controls
 * **Example:** Disable a Control
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateStandardsControl = yield* AWS.SecurityHub.UpdateStandardsControl();
 *
 * // runtime
 * yield* updateStandardsControl({
 *   StandardsControlArn: controlArn,
 *   ControlStatus: "DISABLED",
 *   DisabledReason: "not applicable to this workload",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateStandardsControl extends Binding.Service<
  UpdateStandardsControl,
  "AWS.SecurityHub.UpdateStandardsControl",
  () => Effect.Effect<
    (
      request: securityhub.UpdateStandardsControlRequest,
    ) => Effect.Effect<
      securityhub.UpdateStandardsControlResponse,
      securityhub.UpdateStandardsControlError
    >
  >
> {}
export const UpdateStandardsControl = Binding.Service<UpdateStandardsControl>(
  "AWS.SecurityHub.UpdateStandardsControl",
);

export const UpdateStandardsControlHttp = Layer.effect(
  UpdateStandardsControl,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.UpdateStandardsControl",
    operation: securityhub.updateStandardsControl,
    actions: ["securityhub:UpdateStandardsControl"],
  }),
);
