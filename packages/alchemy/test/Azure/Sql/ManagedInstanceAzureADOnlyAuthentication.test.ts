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
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (resourceGroupName: string, managedInstanceName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedInstanceAzureADOnlyAuthentication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      authenticationName: "Default",
    });
  });

type Step = { azureADOnlyAuthentication: boolean };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceAzureADOnlyAuthentication("Setting", {
            resourceGroup: group.resourceGroupName,
            managedInstance: instance.managedInstanceName,
            ...step,
          });
    return { group, instance, setting };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "set, update, and reset managed instance entra-only authentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { azureADOnlyAuthentication: false }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.azureADOnlyAuthentication === false,
        12,
      );
      expect(observed1.properties?.azureADOnlyAuthentication).toEqual(false);

      // In place update.
      const second = yield* stack.deploy(
        program(password, { azureADOnlyAuthentication: true }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.azureADOnlyAuthentication === true,
        12,
      );
      expect(observed2.properties?.azureADOnlyAuthentication).toEqual(true);

      // Removing the resource allows SQL logins again.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.azureADOnlyAuthentication === false,
          12,
        )).properties?.azureADOnlyAuthentication,
      ).toEqual(false);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 6 * 3_600_000 },
);
