import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * Runtime binding for the `DescribeAutoScalingGroups` operation scoped to one
 * group (IAM action `autoscaling:DescribeAutoScalingGroups`; EC2 Auto Scaling
 * `Describe*` actions do not support resource-level permissions, so the grant
 * is on `*`).
 *
 * Returns the bound group's live description — capacity, instances and their
 * lifecycle states, suspended processes — or `undefined` if the group no
 * longer exists. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.DescribeAutoScalingGroupHttp)`.
 * ### Observing the Fleet
 * **Example:** Inspect live capacity and instances
 * ```typescript
 * // init — bind the operation to the group
 * const describeGroup = yield* AWS.AutoScaling.DescribeAutoScalingGroup(group);
 *
 * // runtime — read the group's live state
 * const live = yield* describeGroup();
 * const inService = (live?.Instances ?? []).filter(
 *   (i) => i.LifecycleState === "InService",
 * );
 * ```
 *
 * @binding
 */
export interface DescribeAutoScalingGroup extends Binding.Service<
  DescribeAutoScalingGroup,
  "AWS.AutoScaling.DescribeAutoScalingGroup",
  (
    group: AutoScalingGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      autoscaling.AutoScalingGroup | undefined,
      autoscaling.DescribeAutoScalingGroupsError
    >
  >
> {}

export const DescribeAutoScalingGroup = Binding.Service<DescribeAutoScalingGroup>(
  "AWS.AutoScaling.DescribeAutoScalingGroup",
);

// Bespoke (not the shared scaffold): `describeAutoScalingGroups` takes the
// group name inside the `AutoScalingGroupNames` array and the client unwraps
// the single-element response.
export const DescribeAutoScalingGroupHttp = Layer.effect(
  DescribeAutoScalingGroup,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describe = yield* AWSBindings.withCredentials(autoscaling.describeAutoScalingGroups);

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.DescribeAutoScalingGroup(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["autoscaling:DescribeAutoScalingGroups"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.AutoScaling.DescribeAutoScalingGroup(${group.LogicalId})`)(
        function* () {
          const result = yield* describe({
            AutoScalingGroupNames: [yield* AutoScalingGroupName],
          });
          return result.AutoScalingGroups?.[0];
        },
      );
    });
  }),
);
