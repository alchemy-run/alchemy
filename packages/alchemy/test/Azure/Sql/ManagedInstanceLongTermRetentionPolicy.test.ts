import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { managedDatabase } from "./managed.ts";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (
  resourceGroupName: string,
  managedInstanceName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedInstanceLongTermRetentionPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
      policyName: "default",
    });
  });

type Step = { weeklyRetention: string };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance, database } = yield* managedDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceLongTermRetentionPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            managedInstance: instance.managedInstanceName,
            database: database.databaseName,
            ...step,
          });
    return { group, instance, database, setting };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "set, update, and reset managed long-term backup retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { weeklyRetention: "P2W" }),
      );
      const { group, instance, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.weeklyRetention === "P2W",
        12,
      );
      expect(observed1.properties?.weeklyRetention).toEqual("P2W");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { weeklyRetention: "P4W" }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.weeklyRetention === "P4W",
        12,
      );
      expect(observed2.properties?.weeklyRetention).toEqual("P4W");

      // Removing the resource turns long-term retention off.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.weeklyRetention === "PT0S",
          12,
        )).properties?.weeklyRetention,
      ).toEqual("PT0S");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 6 * 3_600_000 },
);
