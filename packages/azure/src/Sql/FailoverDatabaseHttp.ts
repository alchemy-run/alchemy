import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Database } from "./Database.ts";
import { FailoverDatabase } from "./FailoverDatabase.ts";

/**
 * Implementation of {@link FailoverDatabase} over the distilled `sql` ARM
 * operation `DatabasesFailover`. Assigns the custom `AzureSqlFailoverDatabaseRole` on
 * the database.
 *
 * @layer
 * @provides Azure.Sql.FailoverDatabase
 */
export const FailoverDatabaseHttp = Layer.effect(
  FailoverDatabase,
  makeArmActionBinding({
    tag: "Azure.Sql.FailoverDatabase",
    operation: sql.DatabasesFailover,
    role: {
      role: "SqlFailoverDatabase",
      actions: ["Microsoft.Sql/servers/databases/failover/action"],
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
