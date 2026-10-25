import * as sql from "@distilled.cloud/azure/sql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Database } from "./Database.ts";
import { ResumeDatabase } from "./ResumeDatabase.ts";

/**
 * Implementation of {@link ResumeDatabase} over the distilled `sql` ARM
 * operation `ResumeDatabase`. Assigns the custom `AzureSqlResumeDatabaseRole` on
 * the database.
 *
 * @layer
 * @provides Azure.Sql.ResumeDatabase
 */
export const ResumeDatabaseHttp = Layer.effect(
  ResumeDatabase,
  makeArmActionBinding({
    tag: "Azure.Sql.ResumeDatabase",
    operation: sql.ResumeDatabase,
    role: {
      role: "SqlResumeDatabase",
      actions: ["Microsoft.Sql/servers/databases/resume/action"],
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
