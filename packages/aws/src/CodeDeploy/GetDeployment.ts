import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeDeployGroupHttpBinding } from "./BindingHttp.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:GetDeployment` — reads a deployment's
 * status, revision, and rollout overview. CodeDeploy authorizes the call
 * against the deployment group the deployment belongs to.
 * ### Observing Deployments
 * **Example:** Poll a Deployment's Status
 * ```typescript
 * const getDeployment = yield* AWS.CodeDeploy.GetDeployment(group);
 *
 * const { deploymentInfo } = yield* getDeployment({ deploymentId });
 * ```
 *
 * @binding
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "AWS.CodeDeploy.GetDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.GetDeploymentInput,
    ) => Effect.Effect<SVC.GetDeploymentOutput, SVC.GetDeploymentError>
  >
> {}
export const GetDeployment = Binding.Service<GetDeployment>("AWS.CodeDeploy.GetDeployment");

export const GetDeploymentHttp = Layer.effect(
  GetDeployment,
  makeCodeDeployGroupHttpBinding({
    tag: "AWS.CodeDeploy.GetDeployment",
    operation: codedeploy.getDeployment,
    actions: ["codedeploy:GetDeployment"],
  }),
);
