import * as rds from "@distilled.cloud/aws/rds";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeDBClusterEndpoints` operation (IAM action
 * `rds:DescribeDBClusterEndpoints`).
 *
 * Lists an Aurora cluster's endpoints (writer, reader, and custom
 * endpoints) with their status and member lists. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBClusterEndpointsHttp)`.
 * ### Monitoring Databases
 * **Example:** List a Cluster's Endpoints
 * ```typescript
 * const describeDBClusterEndpoints =
 *   yield* AWS.RDS.DescribeDBClusterEndpoints();
 *
 * const page = yield* describeDBClusterEndpoints({
 *   DBClusterIdentifier: clusterId,
 * });
 * ```
 *
 * @binding
 */
export interface DescribeDBClusterEndpoints extends Binding.Service<
  DescribeDBClusterEndpoints,
  "AWS.RDS.DescribeDBClusterEndpoints",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBClusterEndpointsMessage,
    ) => Effect.Effect<rds.DBClusterEndpointMessage, rds.DescribeDBClusterEndpointsError>
  >
> {}
export const DescribeDBClusterEndpoints = Binding.Service<DescribeDBClusterEndpoints>(
  "AWS.RDS.DescribeDBClusterEndpoints",
);

export const DescribeDBClusterEndpointsHttp = Layer.effect(
  DescribeDBClusterEndpoints,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBClusterEndpoints",
    operation: rds.describeDBClusterEndpoints,
    actions: ["rds:DescribeDBClusterEndpoints"],
  }),
);
