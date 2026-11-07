import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface DeregisterInstanceRequest extends Omit<
  SD.DeregisterInstanceRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:DeregisterInstance` — lets a
 * self-registering workload remove its own Cloud Map instance (and the
 * Route 53 records/health check Cloud Map created for it).
 *
 * The response carries an `OperationId`; deregistration completes
 * asynchronously on the Cloud Map side.
 * ### Deregistering Instances
 * **Example:** Deregister on Shutdown
 * ```typescript
 * const deregisterInstance = yield* AWS.CloudMap.DeregisterInstance(service);
 *
 * yield* deregisterInstance({ InstanceId: "worker-1" });
 * ```
 *
 * @binding
 */
export interface DeregisterInstance extends Binding.Service<
  DeregisterInstance,
  "AWS.CloudMap.DeregisterInstance",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: DeregisterInstanceRequest,
    ) => Effect.Effect<SD.DeregisterInstanceResponse, SD.DeregisterInstanceError>
  >
> {}
export const DeregisterInstance = Binding.Service<DeregisterInstance>(
  "AWS.CloudMap.DeregisterInstance",
);

export const DeregisterInstanceHttp = Layer.effect(
  DeregisterInstance,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.DeregisterInstance",
    operation: SD.deregisterInstance,
    actions: ["servicediscovery:DeregisterInstance"],
    extraStatements: [
      {
        // Cloud Map deletes the Route 53 records/health check it created
        // for the instance; these actions have no resource-level scoping
        // for this use.
        Effect: "Allow",
        Action: [
          "route53:GetHealthCheck",
          "route53:DeleteHealthCheck",
          "route53:UpdateHealthCheck",
          "route53:ChangeResourceRecordSets",
        ],
        Resource: ["*"],
      },
    ],
  }),
);
