import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DescribeInstances` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:DescribeInstances`; `Describe*` actions
 * do not support resource-level permissions, so the grant is on `*`).
 *
 * Returns the bound instance's live description — state, addresses, block
 * device mappings — e.g. a Lambda that reports whether a dev box is running.
 * Provide the implementation with
 * `Effect.provide(AWS.EC2.DescribeInstanceHttp)`.
 * ### Observing Instances
 * **Example:** Read the bound instance's live state
 * ```typescript
 * // init — bind the operation to the instance
 * const describeInstance = yield* AWS.EC2.DescribeInstance(instance);
 *
 * // runtime — read the live description
 * const live = yield* describeInstance();
 * console.log(live?.State?.Name, live?.PrivateIpAddress);
 * ```
 *
 * @binding
 */
export interface DescribeInstance extends Binding.Service<
  DescribeInstance,
  "AWS.EC2.DescribeInstance",
  (
    instance: Instance,
  ) => Effect.Effect<() => Effect.Effect<ec2.Instance | undefined, ec2.DescribeInstancesError>>
> {}

export const DescribeInstance = Binding.Service<DescribeInstance>("AWS.EC2.DescribeInstance");

// Bespoke (not the shared scaffold): `describeInstances` nests results under
// Reservations[].Instances[] and the client unwraps the single bound
// instance.
export const DescribeInstanceHttp = Layer.effect(
  DescribeInstance,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describe = yield* AWSBindings.withCredentials(ec2.describeInstances);

    return Effect.fn(function* (instance: Instance) {
      const instanceId = yield* instance.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EC2.DescribeInstance(${instance})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ec2:DescribeInstances"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.EC2.DescribeInstance(${instance.LogicalId})`)(function* () {
        const result = yield* describe({
          InstanceIds: [yield* instanceId],
        });
        return result.Reservations?.[0]?.Instances?.[0];
      });
    });
  }),
);
