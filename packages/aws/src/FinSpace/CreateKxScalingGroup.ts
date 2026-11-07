import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:CreateKxScalingGroup` — provisions a shared compute host in the bound environment that multiple kdb clusters can be placed on.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.CreateKxScalingGroupHttp)`.
 * ### Managing Scaling Groups
 * **Example:** Provision a Scaling Group
 * ```typescript
 * const createScalingGroup = yield* AWS.FinSpace.CreateKxScalingGroup(kdb);
 *
 * const group = yield* createScalingGroup({
 *   scalingGroupName: "shared-hosts",
 *   hostType: "kx.sg.4xlarge",
 *   availabilityZoneId: "use1-az2",
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 *
 * @binding
 */
export interface CreateKxScalingGroup extends Binding.Service<
  CreateKxScalingGroup,
  "AWS.FinSpace.CreateKxScalingGroup",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CreateKxScalingGroupRequest, "environmentId">,
    ) => Effect.Effect<SVC.CreateKxScalingGroupResponse, SVC.CreateKxScalingGroupError>
  >
> {}
export const CreateKxScalingGroup = Binding.Service<CreateKxScalingGroup>(
  "AWS.FinSpace.CreateKxScalingGroup",
);

export const CreateKxScalingGroupHttp = Layer.effect(
  CreateKxScalingGroup,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.CreateKxScalingGroup",
    operation: finspace.createKxScalingGroup,
    actions: ["finspace:CreateKxScalingGroup"],
  }),
);
