import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `dms:DescribeOrderableReplicationInstances`.
 *
 * Bind this operation (account-level) to enumerate the replication instance
 * classes and storage ranges orderable in the region — e.g. for tooling that
 * right-sizes migration infrastructure. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeOrderableReplicationInstancesHttp)`.
 * ### Sizing Replication Instances
 * **Example:** List Orderable Instance Classes
 * ```typescript
 * // init — account-level, no target resource
 * const orderable = yield* AWS.DMS.DescribeOrderableReplicationInstances();
 *
 * // runtime
 * const { OrderableReplicationInstances } = yield* orderable();
 * ```
 *
 * @binding
 */
export interface DescribeOrderableReplicationInstances extends Binding.Service<
  DescribeOrderableReplicationInstances,
  "AWS.DMS.DescribeOrderableReplicationInstances",
  () => Effect.Effect<
    (
      request?: dms.DescribeOrderableReplicationInstancesMessage,
    ) => Effect.Effect<
      dms.DescribeOrderableReplicationInstancesResponse,
      dms.DescribeOrderableReplicationInstancesError
    >
  >
> {}

export const DescribeOrderableReplicationInstances =
  Binding.Service<DescribeOrderableReplicationInstances>(
    "AWS.DMS.DescribeOrderableReplicationInstances",
  );

export const DescribeOrderableReplicationInstancesHttp = Layer.effect(
  DescribeOrderableReplicationInstances,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.DescribeOrderableReplicationInstances",
    actions: ["dms:DescribeOrderableReplicationInstances"],
    operation: dms.describeOrderableReplicationInstances,
  }),
);
