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
    return yield* sql.GetSqlAgent({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
    });
  });

type Step = { state: "Enabled" | "Disabled" };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.SqlAgentConfiguration("Setting", {
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
  "set, update, and reset the managed instance sql agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { state: "Disabled" }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Disabled",
        12,
      );
      expect(observed1.properties?.state).toEqual("Disabled");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { state: "Enabled" }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed2.properties?.state).toEqual("Enabled");

      // Removing the resource re-enables SQL Agent.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.state === "Enabled",
          12,
        )).properties?.state,
      ).toEqual("Enabled");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
