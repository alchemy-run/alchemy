import * as Azure from "@alchemy.run/azure";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  sqlDatabase,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLabel = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
  columnName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetSensitivityLabel({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      schemaName: "SalesLT",
      tableName: "Customer",
      columnName,
      sensitivityLabelSource: "current",
    });
  });

type Step =
  | {
      column: string;
      labelName: string;
      informationType: string;
      rank: "Low" | "Medium" | "High";
    }
  | undefined;

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    // The AdventureWorksLT sample provides the SalesLT.Customer table.
    const parent = yield* sqlDatabase(password, { sampleName: "AdventureWorksLT" });
    const { group, server, database } = parent;
    const label =
      step === undefined
        ? undefined
        : yield* Azure.Sql.SensitivityLabel("Label", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            schema: "SalesLT",
            table: "Customer",
            column: step.column,
            labelName: step.labelName,
            informationType: step.informationType,
            rank: step.rank,
          });
    return { ...parent, label };
  });

// Basic database (~$0.007/hour): < $0.01 per run.
test.provider(
  "create, update, replace, and delete a sql sensitivity label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          column: "EmailAddress",
          labelName: "Confidential",
          informationType: "Contact Info",
          rank: "Medium",
        }),
      );
      const rg = first.group.resourceGroupName;
      const serverName = first.server.serverName;
      const databaseName = first.database.databaseName;
      expect(first.label?.labelName).toEqual("Confidential");
      const observed1 = yield* getLabel(rg, serverName, databaseName, "EmailAddress");
      expect(observed1.properties?.labelName).toEqual("Confidential");
      expect(observed1.properties?.informationType).toEqual("Contact Info");
      expect(observed1.properties?.rank).toEqual("Medium");

      // In place: a stricter label on the same column.
      const second = yield* stack.deploy(
        program(password, {
          column: "EmailAddress",
          labelName: "Highly Confidential",
          informationType: "Contact Info",
          rank: "High",
        }),
      );
      expect(second.label?.sensitivityLabelId).toEqual(first.label?.sensitivityLabelId);
      const observed2 = yield* getLabel(rg, serverName, databaseName, "EmailAddress");
      expect(observed2.properties?.labelName).toEqual("Highly Confidential");
      expect(observed2.properties?.rank).toEqual("High");

      // Replace: a different column.
      const third = yield* stack.deploy(
        program(password, {
          column: "Phone",
          labelName: "Confidential",
          informationType: "Contact Info",
          rank: "Low",
        }),
      );
      expect(third.label?.columnName).toEqual("Phone");
      expect(yield* awaitGone(getLabel(rg, serverName, databaseName, "EmailAddress"))).toEqual(
        "gone",
      );
      const observed3 = yield* getLabel(rg, serverName, databaseName, "Phone");
      expect(observed3.properties?.rank).toEqual("Low");

      // Removing the resource deletes the label.
      yield* stack.deploy(program(password, undefined));
      expect(yield* awaitGone(getLabel(rg, serverName, databaseName, "Phone"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
