import * as Azure from "@alchemy.run/azure";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { lakeSqlPool, logLevel, poolPath, withWorkspaceSlot } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A sensitivity label must reference an existing column, which only T-SQL
 * DDL can create (no ARM API). Point this at a `schema.table.column` that a
 * pre-provisioning step created in the pool.
 */
const column = process.env.AZURE_TEST_SYNAPSE_LABELLED_COLUMN?.split(".");
const [schemaName, tableName, columnName] = [
  column?.[0] ?? "dbo",
  column?.[1] ?? "customers",
  column?.[2] ?? "email",
];

const program = (label: { labelName: string; rank: "Medium" | "High" } | undefined) =>
  Effect.gen(function* () {
    const { group, workspace, pool } = yield* lakeSqlPool();
    if (label === undefined) return { pool, sensitivity: undefined };
    const sensitivity = yield* Azure.Synapse.SqlPoolSensitivityLabel("EmailLabel", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      sqlPool: pool.sqlPoolName,
      schemaName,
      tableName,
      columnName,
      labelName: label.labelName,
      informationType: "Contact Info",
      rank: label.rank,
    });
    return { pool, sensitivity };
  });

const getLabel = (pool: { resourceGroup: string; workspaceName: string; sqlPoolName: string }) =>
  Effect.gen(function* () {
    const path = yield* poolPath(pool);
    return yield* synapse.GetSqlPoolSensitivityLabel({
      ...path,
      schemaName,
      tableName,
      columnName,
      sensitivityLabelSource: "current",
    });
  });

// ~$1.50/run, 15 min: a DW100c dedicated SQL pool (~$1.20-1.51 per started
// hour, ~5-10 min to create) and a table created with T-SQL.
test.provider.skipIf(!runExpensive || column === undefined)(
  "create, update, and delete a synapse sql pool sensitivity label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pool, sensitivity } = yield* stack.deploy(
        program({ labelName: "Confidential", rank: "Medium" }),
      );
      expect(sensitivity?.labelName).toEqual("Confidential");
      const observed = yield* getLabel(pool);
      expect(observed.properties?.labelName).toEqual("Confidential");
      expect(observed.properties?.informationType).toEqual("Contact Info");
      expect(observed.properties?.rank).toEqual("Medium");

      // In place: raise the label.
      const updated = yield* stack.deploy(
        program({ labelName: "Highly Confidential", rank: "High" }),
      );
      expect(updated.sensitivity?.labelResourceId).toEqual(sensitivity?.labelResourceId);
      const reobserved = yield* getLabel(pool);
      expect(reobserved.properties?.labelName).toEqual("Highly Confidential");
      expect(reobserved.properties?.rank).toEqual("High");

      // Removing the resource removes the label from the column.
      yield* stack.deploy(program(undefined));
      const cleared = yield* getLabel(pool).pipe(
        // A column without a label reads back as an empty shell or a 404.
        Effect.map((label) => (label.properties?.labelName ? "set" : "gone")),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status === "gone",
          times: 24,
        }),
      );
      expect(cleared).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 1_200_000,
  },
);
