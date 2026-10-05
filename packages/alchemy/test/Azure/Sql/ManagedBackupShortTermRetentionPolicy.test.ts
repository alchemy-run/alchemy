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
    return yield* sql.GetManagedBackupShortTermRetentionPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
      policyName: "default",
    });
  });

type Step = { retentionDays: number };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance, database } = yield* managedDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedBackupShortTermRetentionPolicy("Setting", {
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
  "set, update, and reset managed short-term backup retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { retentionDays: 14 }),
      );
      const { group, instance, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.retentionDays === 14,
        12,
      );
      expect(observed1.properties?.retentionDays).toEqual(14);

      // In place update.
      const second = yield* stack.deploy(
        program(password, { retentionDays: 21 }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.retentionDays === 21,
        12,
      );
      expect(observed2.properties?.retentionDays).toEqual(21);

      // Removing the resource resets retention to 7 days.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.retentionDays === 7,
          12,
        )).properties?.retentionDays,
      ).toEqual(7);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
