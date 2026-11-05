import * as rds from "@distilled.cloud/aws/rds";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeDBClusters` operation (IAM action
 * `rds:DescribeDBClusters`).
 *
 * Lists the account's RDS/Aurora clusters (or one cluster by identifier) —
 * status, endpoints, members, engine versions — for health checks and
 * cluster discovery. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBClustersHttp)`.
 * ### Monitoring Databases
 * **Example:** Check a Cluster's Status
 * ```typescript
 * const describeDBClusters = yield* AWS.RDS.DescribeDBClusters();
 *
 * const page = yield* describeDBClusters({
 *   DBClusterIdentifier: clusterId,
 * });
 * const status = page.DBClusters?.[0]?.Status;
 * ```
 *
 * @binding
 */
export interface DescribeDBClusters extends Binding.Service<
  DescribeDBClusters,
  "AWS.RDS.DescribeDBClusters",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBClustersMessage,
    ) => Effect.Effect<rds.DBClusterMessage, rds.DescribeDBClustersError>
  >
> {}
export const DescribeDBClusters = Binding.Service<DescribeDBClusters>("AWS.RDS.DescribeDBClusters");

export const DescribeDBClustersHttp = Layer.effect(
  DescribeDBClusters,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBClusters",
    operation: rds.describeDBClusters,
    actions: ["rds:DescribeDBClusters"],
  }),
);
