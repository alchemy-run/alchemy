import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:StopDeployment` — attempts to stop an
 * ongoing deployment of the bound deployment group (optionally rolling
 * back).
 * ### Controlling Deployments
 * **Example:** Stop and Roll Back
 * ```typescript
 * const stopDeployment = yield* AWS.CodeDeploy.StopDeployment(group);
 *
 * const { status } = yield* stopDeployment({
 *   deploymentId,
 *   autoRollbackEnabled: true,
 * });
 * ```
 *
 * @binding
 */
export interface StopDeployment extends Binding.Service<
  StopDeployment,
  "AWS.CodeDeploy.StopDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.StopDeploymentInput,
    ) => Effect.Effect<SVC.StopDeploymentOutput, SVC.StopDeploymentError>
  >
> {}
export const StopDeployment = Binding.Service<StopDeployment>("AWS.CodeDeploy.StopDeployment");

export const StopDeploymentHttp = Layer.effect(
  StopDeployment,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.StopDeployment",
    operation: codedeploy.stopDeployment,
    actions: ["codedeploy:StopDeployment"],
  }),
);
