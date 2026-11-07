import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * `EnterStandby` request with `AutoScalingGroupName` injected from the bound
 * {@link AutoScalingGroup}.
 */
export interface EnterStandbyRequest extends Omit<
  autoscaling.EnterStandbyQuery,
  "AutoScalingGroupName"
> {}

/**
 * `ExitStandby` request with `AutoScalingGroupName` injected from the bound
 * {@link AutoScalingGroup}.
 */
export interface ExitStandbyRequest extends Omit<
  autoscaling.ExitStandbyQuery,
  "AutoScalingGroupName"
> {}

export interface StandbyClient {
  /**
   * Move instances into `Standby` — they stay attached (and optionally keep
   * counting toward desired capacity) but receive no load balancer traffic.
   */
  enter: (
    request: EnterStandbyRequest,
  ) => Effect.Effect<autoscaling.EnterStandbyAnswer, autoscaling.EnterStandbyError>;
  /**
   * Move standby instances back into service; the desired capacity is
   * incremented accordingly.
   */
  exit: (
    request: ExitStandbyRequest,
  ) => Effect.Effect<autoscaling.ExitStandbyAnswer, autoscaling.ExitStandbyError>;
}

/**
 * Runtime binding for the `EnterStandby` / `ExitStandby` operations (IAM
 * actions `autoscaling:EnterStandby` and `autoscaling:ExitStandby` scoped to
 * the group ARN).
 *
 * Temporarily pulls instances out of service — to debug a misbehaving
 * instance, apply a patch, or drain it during maintenance — and puts them
 * back afterwards. Provide the implementation with
 * `Effect.provide(AWS.AutoScaling.StandbyHttp)`.
 * ### Standby Maintenance
 * **Example:** Pull an instance for maintenance, then return it
 * ```typescript
 * // init — bind the operations to the group
 * const standby = yield* AWS.AutoScaling.Standby(group);
 *
 * // runtime — take the instance out of rotation
 * yield* standby.enter({
 *   InstanceIds: [instanceId],
 *   ShouldDecrementDesiredCapacity: true,
 * });
 *
 * // ... perform maintenance ...
 *
 * // runtime — put it back in service
 * yield* standby.exit({ InstanceIds: [instanceId] });
 * ```
 *
 * @binding
 */
export interface Standby extends Binding.Service<
  Standby,
  "AWS.AutoScaling.Standby",
  (group: AutoScalingGroup) => Effect.Effect<StandbyClient>
> {}

export const Standby = Binding.Service<Standby>("AWS.AutoScaling.Standby");

// Bespoke (not the shared scaffold): a multi-operation client over
// `enterStandby` + `exitStandby` behind one IAM grant.
export const StandbyHttp = Layer.effect(
  Standby,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const enter = yield* AWSBindings.withCredentials(autoscaling.enterStandby);
    const exit = yield* AWSBindings.withCredentials(autoscaling.exitStandby);

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.Standby(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["autoscaling:EnterStandby", "autoscaling:ExitStandby"],
              Resource: [group.autoScalingGroupArn],
            },
          ],
        });
      }
      return {
        enter: Effect.fn(`AWS.AutoScaling.EnterStandby(${group.LogicalId})`)(function* (
          request: EnterStandbyRequest,
        ) {
          return yield* enter({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
        exit: Effect.fn(`AWS.AutoScaling.ExitStandby(${group.LogicalId})`)(function* (
          request: ExitStandbyRequest,
        ) {
          return yield* exit({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
      };
    });
  }),
);
