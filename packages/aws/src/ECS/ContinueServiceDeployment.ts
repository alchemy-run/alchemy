import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface ContinueServiceDeploymentRequest extends ECS.ContinueServiceDeploymentRequest {}

/**
 * Runtime binding for `ecs:ContinueServiceDeployment`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that resumes a blue/green deployment paused at a lifecycle-hook
 * stage — the canonical consumer is the deployment lifecycle-hook Lambda
 * that validates the green revision and then approves (or vetoes) the
 * traffic shift. The host is granted `ecs:ContinueServiceDeployment` on the
 * bound service's deployments.
 * ### Service Deployments
 * **Example:** Approve a Lifecycle-Hook Stage
 * ```typescript
 * const continueServiceDeployment =
 *   yield* AWS.ECS.ContinueServiceDeployment(service);
 *
 * yield* continueServiceDeployment({
 *   serviceDeploymentArn: deploymentArn,
 *   hookId,
 * });
 * ```
 *
 * @binding
 */
export interface ContinueServiceDeployment extends Binding.Service<
  ContinueServiceDeployment,
  "AWS.ECS.ContinueServiceDeployment",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: ContinueServiceDeploymentRequest,
    ) => Effect.Effect<ECS.ContinueServiceDeploymentResponse, ECS.ContinueServiceDeploymentError>
  >
> {}
export const ContinueServiceDeployment = Binding.Service<ContinueServiceDeployment>(
  "AWS.ECS.ContinueServiceDeployment",
);

export const ContinueServiceDeploymentHttp = Layer.effect(
  ContinueServiceDeployment,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.ContinueServiceDeployment",
    operation: ECS.continueServiceDeployment,
    actions: ["ecs:ContinueServiceDeployment"],
    // Authorizes against the service-deployment resource:
    // arn:aws:ecs:{region}:{account}:service-deployment/{cluster}/{service}/*
    resources: ["service-deployment"],
  }),
);
