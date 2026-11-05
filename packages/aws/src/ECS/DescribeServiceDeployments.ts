import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEcsServiceHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface DescribeServiceDeploymentsRequest extends ECS.DescribeServiceDeploymentsRequest {}

/**
 * Runtime binding for `ecs:DescribeServiceDeployments`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that describes the bound service's deployments — rollout state,
 * circuit-breaker status, target service revision. The host is granted
 * `ecs:DescribeServiceDeployments` on the service's deployments (deployment
 * ARNs are only known at runtime, e.g. from `ListServiceDeployments`).
 * ### Service Deployments
 * **Example:** Inspect a Deployment's Rollout State
 * ```typescript
 * const describeServiceDeployments =
 *   yield* AWS.ECS.DescribeServiceDeployments(service);
 *
 * const response = yield* describeServiceDeployments({
 *   serviceDeploymentArns: [deploymentArn],
 * });
 * const status = response.serviceDeployments?.[0]?.status;
 * ```
 *
 * @binding
 */
export interface DescribeServiceDeployments extends Binding.Service<
  DescribeServiceDeployments,
  "AWS.ECS.DescribeServiceDeployments",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: DescribeServiceDeploymentsRequest,
    ) => Effect.Effect<ECS.DescribeServiceDeploymentsResponse, ECS.DescribeServiceDeploymentsError>
  >
> {}
export const DescribeServiceDeployments = Binding.Service<DescribeServiceDeployments>(
  "AWS.ECS.DescribeServiceDeployments",
);

export const DescribeServiceDeploymentsHttp = Layer.effect(
  DescribeServiceDeployments,
  makeEcsServiceHttpBinding({
    tag: "AWS.ECS.DescribeServiceDeployments",
    operation: ECS.describeServiceDeployments,
    actions: ["ecs:DescribeServiceDeployments"],
    // Authorizes against the service-deployment resource:
    // arn:aws:ecs:{region}:{account}:service-deployment/{cluster}/{service}/*
    resources: ["service-deployment"],
  }),
);
