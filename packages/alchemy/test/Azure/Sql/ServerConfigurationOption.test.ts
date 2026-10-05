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
    return yield* sql.GetServerConfigurationOption({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      serverConfigurationOptionName: "allowPolybaseExport",
    });
  });

type Step = { serverConfigurationOptionValue: 0 | 1 };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ServerConfigurationOption("Setting", {
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
  "set, update, and reset a managed instance configuration option",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { serverConfigurationOptionValue: 1 }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.serverConfigurationOptionValue === 1,
        12,
      );
      expect(observed1.properties?.serverConfigurationOptionValue).toEqual(1);

      // In place update.
      const second = yield* stack.deploy(
        program(password, { serverConfigurationOptionValue: 0 }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.serverConfigurationOptionValue === 0,
        12,
      );
      expect(observed2.properties?.serverConfigurationOptionValue).toEqual(0);

      // Removing the resource resets the option to 0.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.serverConfigurationOptionValue === 0,
          12,
        )).properties?.serverConfigurationOptionValue,
      ).toEqual(0);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
