import * as synapse from "@distilled.cloud/azure/synapse";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { ResumeSqlPool } from "./ResumeSqlPool.ts";
import type { SqlPool } from "./SqlPool.ts";

/**
 * Implementation of {@link ResumeSqlPool} over the distilled `synapse` ARM
 * operation `ResumeSqlPool`. Assigns the custom `AzureSynapseResumeSqlPoolRole` on
 * the SQL pool.
 *
 * @layer
 * @provides Azure.Synapse.ResumeSqlPool
 */
export const ResumeSqlPoolHttp = Layer.effect(
  ResumeSqlPool,
  makeArmActionBinding({
    tag: "Azure.Synapse.ResumeSqlPool",
    operation: synapse.ResumeSqlPool,
    role: {
      role: "SynapseResumeSqlPool",
      actions: ["Microsoft.Synapse/workspaces/sqlPools/resume/action"],
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
