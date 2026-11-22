import * as synapse from "@distilled.cloud/azure/synapse";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { PauseSqlPool } from "./PauseSqlPool.ts";
import type { SqlPool } from "./SqlPool.ts";

/**
 * Implementation of {@link PauseSqlPool} over the distilled `synapse` ARM
 * operation `PauseSqlPool`. Assigns the custom `AzureSynapsePauseSqlPoolRole` on
 * the SQL pool.
 *
 * @layer
 * @provides Azure.Synapse.PauseSqlPool
 */
export const PauseSqlPoolHttp = Layer.effect(
  PauseSqlPool,
  makeArmActionBinding({
    tag: "Azure.Synapse.PauseSqlPool",
    operation: synapse.PauseSqlPool,
    role: {
      role: "SynapsePauseSqlPool",
      actions: ["Microsoft.Synapse/workspaces/sqlPools/pause/action"],
    },
    resourceId: (pool: SqlPool) => pool.sqlPoolId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      workspaceName: id.name("workspaces"),
      sqlPoolName: id.name("sqlPools"),
    }),
  }),
);
