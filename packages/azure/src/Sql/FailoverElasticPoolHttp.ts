import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { ElasticPool } from "./ElasticPool.ts";
import { FailoverElasticPool } from "./FailoverElasticPool.ts";

/**
 * Implementation of {@link FailoverElasticPool} over the distilled `sql` ARM
 * operation `ElasticPoolsFailover`. Assigns the custom `AzureSqlFailoverElasticPoolRole` on
 * the elastic pool.
 *
 * @layer
 * @provides Azure.Sql.FailoverElasticPool
 */
export const FailoverElasticPoolHttp = Layer.effect(
  FailoverElasticPool,
  makeArmActionBinding({
    tag: "Azure.Sql.FailoverElasticPool",
    operation: sql.ElasticPoolsFailover,
    role: {
      role: "SqlFailoverElasticPool",
      actions: ["Microsoft.Sql/servers/elasticPools/failover/action"],
    },
    resourceId: (pool: ElasticPool) => pool.elasticPoolId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("servers"),
      elasticPoolName: id.name("elasticPools"),
    }),
  }),
);
