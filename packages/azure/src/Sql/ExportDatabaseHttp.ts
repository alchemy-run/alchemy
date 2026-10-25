import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Database } from "./Database.ts";
import { ExportDatabase } from "./ExportDatabase.ts";

/**
 * Implementation of {@link ExportDatabase} over the distilled `sql` ARM
 * operation `ExportDatabase`. Assigns the custom `AzureSqlExportDatabaseRole` on
 * the database.
 *
 * @layer
 * @provides Azure.Sql.ExportDatabase
 */
export const ExportDatabaseHttp = Layer.effect(
  ExportDatabase,
  makeArmActionBinding({
    tag: "Azure.Sql.ExportDatabase",
    operation: sql.ExportDatabase,
    role: {
      role: "SqlExportDatabase",
      actions: ["Microsoft.Sql/servers/databases/export/action"],
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
