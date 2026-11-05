import * as rds from "@distilled.cloud/aws/rds";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeDBSnapshots` operation (IAM action
 * `rds:DescribeDBSnapshots`).
 *
 * Lists the account's DB instance snapshots — the discovery half of a
 * snapshot-rotation or verification function. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBSnapshotsHttp)`.
 * ### Managing Instance Snapshots
 * **Example:** List an Instance's Manual Snapshots
 * ```typescript
 * const describeDBSnapshots = yield* AWS.RDS.DescribeDBSnapshots();
 *
 * const page = yield* describeDBSnapshots({
 *   DBInstanceIdentifier: instanceId,
 *   SnapshotType: "manual",
 * });
 * ```
 *
 * @binding
 */
export interface DescribeDBSnapshots extends Binding.Service<
  DescribeDBSnapshots,
  "AWS.RDS.DescribeDBSnapshots",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBSnapshotsMessage,
    ) => Effect.Effect<rds.DBSnapshotMessage, rds.DescribeDBSnapshotsError>
  >
> {}
export const DescribeDBSnapshots = Binding.Service<DescribeDBSnapshots>(
  "AWS.RDS.DescribeDBSnapshots",
);

export const DescribeDBSnapshotsHttp = Layer.effect(
  DescribeDBSnapshots,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBSnapshots",
    operation: rds.describeDBSnapshots,
    actions: ["rds:DescribeDBSnapshots"],
  }),
);
