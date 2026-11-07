import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `StartInstanceRefresh` request with `AutoScalingGroupName` injected from
 * the bound {@link AutoScalingGroup}.
 */
export interface StartInstanceRefreshRequest extends Omit<
  autoscaling.StartInstanceRefreshType,
  "AutoScalingGroupName"
> {}

/**
 * `CancelInstanceRefresh` request with `AutoScalingGroupName` injected from
 * the bound {@link AutoScalingGroup}.
 */
export interface CancelInstanceRefreshRequest extends Omit<
  autoscaling.CancelInstanceRefreshType,
  "AutoScalingGroupName"
> {}

/**
 * `DescribeInstanceRefreshes` request with `AutoScalingGroupName` injected
 * from the bound {@link AutoScalingGroup}.
 */
export interface DescribeInstanceRefreshesRequest extends Omit<
  autoscaling.DescribeInstanceRefreshesType,
  "AutoScalingGroupName"
> {}

export interface InstanceRefreshClient {
  /**
   * Begin rolling the group's instances onto the current launch template (or
   * the supplied `DesiredConfiguration`). Returns the refresh id to track.
   */
  start: (
    request?: StartInstanceRefreshRequest,
  ) => Effect.Effect<autoscaling.StartInstanceRefreshAnswer, autoscaling.StartInstanceRefreshError>;
  /**
   * Cancel the in-progress refresh. Instances already replaced are not rolled
   * back — use `rollback` for that.
   */
  cancel: (
    request?: CancelInstanceRefreshRequest,
  ) => Effect.Effect<
    autoscaling.CancelInstanceRefreshAnswer,
    autoscaling.CancelInstanceRefreshError
  >;
  /**
   * Roll the group back to the configuration it had before the in-progress
   * refresh started.
   */
  rollback: () => Effect.Effect<
    autoscaling.RollbackInstanceRefreshAnswer,
    autoscaling.RollbackInstanceRefreshError
  >;
  /**
   * Page through the group's instance refreshes (newest first), including
   * per-refresh status and progress details.
   */
  describe: (
    request?: DescribeInstanceRefreshesRequest,
  ) => Effect.Effect<
    autoscaling.DescribeInstanceRefreshesAnswer,
    autoscaling.DescribeInstanceRefreshesError
  >;
}

/**
 * Runtime binding for the instance refresh operations — `StartInstanceRefresh`,
 * `CancelInstanceRefresh`, `RollbackInstanceRefresh` (IAM actions scoped to
 * the group ARN) and `DescribeInstanceRefreshes` (granted on `*`; EC2 Auto
 * Scaling `Describe*` actions do not support resource-level permissions).
 *
 * Lets a deploy pipeline Lambda roll the fleet onto a new launch template
 * version, watch progress, and cancel or roll back a bad deploy. Provide the
 * implementation with `Effect.provide(AWS.AutoScaling.InstanceRefreshHttp)`.
 * ### Rolling Deployments
 * **Example:** Roll the fleet and watch progress
 * ```typescript
 * // init — bind the operations to the group
 * const refresh = yield* AWS.AutoScaling.InstanceRefresh(group);
 *
 * // runtime — start a rolling replacement with auto-rollback
 * const { InstanceRefreshId } = yield* refresh.start({
 *   Preferences: { MinHealthyPercentage: 90, AutoRollback: true },
 * });
 *
 * // runtime — check on it
 * const page = yield* refresh.describe({
 *   InstanceRefreshIds: [InstanceRefreshId!],
 * });
 * ```
 *
 * **Example:** Cancel a bad deploy
 * ```typescript
 * yield* refresh.cancel().pipe(
 *   Effect.catchTag("ActiveInstanceRefreshNotFoundFault", () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface InstanceRefresh extends Binding.Service<
  InstanceRefresh,
  "AWS.AutoScaling.InstanceRefresh",
  (group: AutoScalingGroup) => Effect.Effect<InstanceRefreshClient>
> {}

export const InstanceRefresh = Binding.Service<InstanceRefresh>("AWS.AutoScaling.InstanceRefresh");

// Bespoke (not the shared scaffold): a multi-operation client over the four
// instance refresh operations behind one two-statement IAM grant (the write
// actions are group-scoped, Describe* only supports `*`).
export const InstanceRefreshHttp = Layer.effect(
  InstanceRefresh,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const start = yield* AWSBindings.withCredentials(autoscaling.startInstanceRefresh);
    const cancel = yield* AWSBindings.withCredentials(autoscaling.cancelInstanceRefresh);
    const rollback = yield* AWSBindings.withCredentials(autoscaling.rollbackInstanceRefresh);
    const describe = yield* AWSBindings.withCredentials(autoscaling.describeInstanceRefreshes);

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.InstanceRefresh(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "autoscaling:StartInstanceRefresh",
                "autoscaling:CancelInstanceRefresh",
                "autoscaling:RollbackInstanceRefresh",
              ],
              Resource: [group.autoScalingGroupArn],
            },
            {
              Effect: "Allow",
              Action: ["autoscaling:DescribeInstanceRefreshes"],
              Resource: ["*"],
            },
          ],
        });
      }
      return {
        start: Effect.fn(`AWS.AutoScaling.StartInstanceRefresh(${group.LogicalId})`)(function* (
          request?: StartInstanceRefreshRequest,
        ) {
          return yield* start({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
        cancel: Effect.fn(`AWS.AutoScaling.CancelInstanceRefresh(${group.LogicalId})`)(function* (
          request?: CancelInstanceRefreshRequest,
        ) {
          return yield* cancel({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
        rollback: Effect.fn(`AWS.AutoScaling.RollbackInstanceRefresh(${group.LogicalId})`)(
          function* () {
            return yield* rollback({
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
        describe: Effect.fn(`AWS.AutoScaling.DescribeInstanceRefreshes(${group.LogicalId})`)(
          function* (request?: DescribeInstanceRefreshesRequest) {
            return yield* describe({
              ...request,
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
      };
    });
  }),
);
