import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { managedInstance } from "./managed.ts";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDatabase = (
  resourceGroupName: string,
  managedInstanceName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedDatabase({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
    });
  });

const program = (
  password: Redacted.Redacted<string>,
  props: { name?: string; tags: Record<string, string> },
) =>
  Effect.gen(function* () {
    const mi = yield* managedInstance(password);
    const database = yield* Azure.Sql.ManagedDatabase("Orders", {
      resourceGroup: mi.group.resourceGroupName,
      managedInstance: mi.instance.managedInstanceName,
      name: props.name,
      tags: props.tags,
    });
    return { ...mi, database };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a managed database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;
      const first = yield* stack.deploy(
        program(password, { tags: { env: "test" } }),
      );
      expect(first.database.status).toEqual("Online");
      const get = (name: string) =>
        getDatabase(
          first.group.resourceGroupName,
          first.instance.managedInstanceName,
          name,
        );
      expect((yield* get(first.database.databaseName)).tags?.env).toEqual(
        "test",
      );

      // In place: tags.
      const second = yield* stack.deploy(
        program(password, { tags: { env: "prod" } }),
      );
      expect(second.database.databaseId).toEqual(first.database.databaseId);
      expect((yield* get(first.database.databaseName)).tags?.env).toEqual(
        "prod",
      );

      // Renaming replaces the database.
      const third = yield* stack.deploy(
        program(password, { name: "alchemy-renamed", tags: { env: "prod" } }),
      );
      expect(third.database.databaseName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.database.databaseName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
