import * as Azure from "@alchemy.run/azure";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { awaitGone, logLevel, newPassword, SQL_TAGS, subscription } from "./harness.ts";
import { managedDatabase } from "./managed.ts";

const { test } = Test.make({ providers: Azure.providers() });

const SCHEMA = "dbo";
const TABLE = "Customer";

const getLabel = (
  resourceGroupName: string,
  managedInstanceName: string,
  databaseName: string,
  columnName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedDatabaseSensitivityLabel({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
      schemaName: SCHEMA,
      tableName: TABLE,
      columnName,
      sensitivityLabelSource: "current",
    });
  });

type Step = { column: string; labelName: string; rank: "Low" | "Medium" | "High" } | undefined;

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const mi = yield* managedDatabase(password);
    const label =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedDatabaseSensitivityLabel("Label", {
            resourceGroup: mi.group.resourceGroupName,
            managedInstance: mi.instance.managedInstanceName,
            database: mi.database.databaseName,
            schema: SCHEMA,
            table: TABLE,
            column: step.column,
            labelName: step.labelName,
            informationType: "Contact Info",
            rank: step.rank,
          });
    return { ...mi, label };
  });

// ~$5/run, 1-6 hours (managed instance, see managed.ts).
// Skipped: the label needs a `dbo.Customer` table with `EmailAddress` and
// `Phone` columns, and a new managed database is empty. ARM cannot create
// tables and the test harness has no T-SQL client, so create the table
// (over the instance's public data endpoint) before running this case.
// The same lifecycle runs live for Azure SQL Database in
// SensitivityLabel.test.ts.
test.provider.skip(
  "create, update, replace, and delete a managed database sensitivity label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { column: "EmailAddress", labelName: "Confidential", rank: "Medium" }),
      );
      const rg = first.group.resourceGroupName;
      const instanceName = first.instance.managedInstanceName;
      const databaseName = first.database.databaseName;
      const observed1 = yield* getLabel(rg, instanceName, databaseName, "EmailAddress");
      expect(observed1.properties?.labelName).toEqual("Confidential");
      expect(observed1.properties?.rank).toEqual("Medium");

      // In place: a stricter label on the same column.
      const second = yield* stack.deploy(
        program(password, {
          column: "EmailAddress",
          labelName: "Highly Confidential",
          rank: "High",
        }),
      );
      expect(second.label?.sensitivityLabelId).toEqual(first.label?.sensitivityLabelId);
      const observed2 = yield* getLabel(rg, instanceName, databaseName, "EmailAddress");
      expect(observed2.properties?.labelName).toEqual("Highly Confidential");

      // Replace: a different column.
      yield* stack.deploy(
        program(password, { column: "Phone", labelName: "Confidential", rank: "Low" }),
      );
      expect(yield* awaitGone(getLabel(rg, instanceName, databaseName, "EmailAddress"))).toEqual(
        "gone",
      );
      const observed3 = yield* getLabel(rg, instanceName, databaseName, "Phone");
      expect(observed3.properties?.rank).toEqual("Low");

      // Removing the resource deletes the label.
      yield* stack.deploy(program(password, undefined));
      expect(yield* awaitGone(getLabel(rg, instanceName, databaseName, "Phone"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 21_600_000 },
);
