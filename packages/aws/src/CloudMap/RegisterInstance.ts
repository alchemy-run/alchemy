import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface RegisterInstanceRequest extends Omit<SD.RegisterInstanceRequest, "ServiceId"> {}

/**
 * Runtime binding for `servicediscovery:RegisterInstance` — lets a
 * self-registering workload create or update its own Cloud Map instance
 * (an upsert on the instance ID).
 *
 * The response carries an `OperationId`; registration completes
 * asynchronously on the Cloud Map side.
 * ### Registering Instances
 * **Example:** Self-register on Startup
 * ```typescript
 * const registerInstance = yield* AWS.CloudMap.RegisterInstance(service);
 *
 * yield* registerInstance({
 *   InstanceId: "worker-1",
 *   Attributes: { AWS_INSTANCE_IPV4: "10.0.1.10" },
 * });
 * ```
 *
 * @binding
 */
export interface RegisterInstance extends Binding.Service<
  RegisterInstance,
  "AWS.CloudMap.RegisterInstance",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: RegisterInstanceRequest,
    ) => Effect.Effect<SD.RegisterInstanceResponse, SD.RegisterInstanceError>
  >
> {}
export const RegisterInstance = Binding.Service<RegisterInstance>("AWS.CloudMap.RegisterInstance");

export const RegisterInstanceHttp = Layer.effect(
  RegisterInstance,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.RegisterInstance",
    operation: SD.registerInstance,
    actions: ["servicediscovery:RegisterInstance"],
    extraStatements: [
      {
        // For DNS services Cloud Map creates Route 53 records and
        // (optionally) health checks on the caller's behalf; these
        // actions have no resource-level scoping for this use.
        Effect: "Allow",
        Action: [
          "route53:GetHealthCheck",
          "route53:CreateHealthCheck",
          "route53:UpdateHealthCheck",
          "route53:ChangeResourceRecordSets",
          "ec2:DescribeInstances",
        ],
        Resource: ["*"],
      },
    ],
  }),
);
