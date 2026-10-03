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
    return yield* sql.GetManagedDatabaseSecurityAlertPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
      securityAlertPolicyName: "Default",
    });
  });

type Step = { state: "Enabled" | "Disabled"; emailAddresses?: string[] };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance, database } = yield* managedDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedDatabaseSecurityAlertPolicy("Setting", {
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
  "set, update, and reset a managed security alert policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          emailAddresses: ["alerts@example.com"],
        }),
      );
      const { group, instance, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed1.properties?.emailAddresses).toEqual([
        "alerts@example.com",
      ]);

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          emailAddresses: ["security@example.com"],
        }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.emailAddresses?.[0] === "security@example.com",
        12,
      );
      expect(observed2.properties?.emailAddresses).toEqual([
        "security@example.com",
      ]);

      // Removing the resource disables the alerts.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.state === "Disabled",
          12,
        )).properties?.state,
      ).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 6 * 3_600_000 },
);
