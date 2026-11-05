import * as neptune from "@distilled.cloud/aws/neptune";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeDBInstances` operation (IAM action
 * `rds:DescribeDBInstances`).
 *
 * Lists the account's Neptune instances (or one instance by identifier) —
 * status, endpoint, instance class, cluster membership — for health checks
 * and reader discovery. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DescribeDBInstancesHttp)`.
 * ### Monitoring Clusters
 * **Example:** Check an Instance's Status
 * ```typescript
 * const describeDBInstances = yield* AWS.Neptune.DescribeDBInstances();
 *
 * const page = yield* describeDBInstances({
 *   DBInstanceIdentifier: instanceId,
 * });
 * const status = page.DBInstances?.[0]?.DBInstanceStatus;
 * ```
 *
 * @binding
 */
export interface DescribeDBInstances extends Binding.Service<
  DescribeDBInstances,
  "AWS.Neptune.DescribeDBInstances",
  () => Effect.Effect<
    (
      request?: neptune.DescribeDBInstancesMessage,
    ) => Effect.Effect<neptune.DBInstanceMessage, neptune.DescribeDBInstancesError>
  >
> {}
export const DescribeDBInstances = Binding.Service<DescribeDBInstances>(
  "AWS.Neptune.DescribeDBInstances",
);

export const DescribeDBInstancesHttp = Layer.effect(
  DescribeDBInstances,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeDBInstances",
    operation: neptune.describeDBInstances,
    actions: ["rds:DescribeDBInstances"],
  }),
);
