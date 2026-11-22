import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Database } from "./Database.ts";
import { PauseDatabase } from "./PauseDatabase.ts";

/**
 * Implementation of {@link PauseDatabase} over the distilled `sql` ARM
 * operation `PauseDatabase`. Assigns the custom `AzureSqlPauseDatabaseRole` on
 * the database.
 *
 * @layer
 * @provides Azure.Sql.PauseDatabase
 */
export const PauseDatabaseHttp = Layer.effect(
  PauseDatabase,
  makeArmActionBinding({
    tag: "Azure.Sql.PauseDatabase",
    operation: sql.PauseDatabase,
    role: {
      role: "SqlPauseDatabase",
      actions: ["Microsoft.Sql/servers/databases/pause/action"],
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
