import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { CreateRestorePoint } from "./CreateRestorePoint.ts";
import type { Database } from "./Database.ts";

/**
 * Implementation of {@link CreateRestorePoint} over the distilled `sql` ARM
 * operation `CreateRestorePoint`. Assigns the custom `AzureSqlCreateRestorePointRole` on
 * the database.
 *
 * @layer
 * @provides Azure.Sql.CreateRestorePoint
 */
export const CreateRestorePointHttp = Layer.effect(
  CreateRestorePoint,
  makeArmActionBinding({
    tag: "Azure.Sql.CreateRestorePoint",
    operation: sql.CreateRestorePoint,
    role: {
      role: "SqlCreateRestorePoint",
      actions: ["Microsoft.Sql/servers/databases/restorePoints/action"],
    },
    resourceId: (database: Database) => database.databaseId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("servers"),
      databaseName: id.name("databases"),
    }),
  }),
);
