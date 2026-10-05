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
    return yield* sql.GetManagedInstanceDtc({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      dtcName: "current",
    });
  });

type Step = { dtcEnabled: boolean; externalDnsSuffixSearchList?: string[] };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ManagedInstanceDtc("Setting", {
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
  "set, update, and reset the managed instance dtc",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { dtcEnabled: true }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.dtcEnabled === true,
        12,
      );
      expect(observed1.properties?.dtcEnabled).toEqual(true);

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          dtcEnabled: true,
          externalDnsSuffixSearchList: ["corp.example.com"],
        }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) =>
          o.properties?.externalDnsSuffixSearchList?.[0] === "corp.example.com",
        12,
      );
      // Azure always keeps the DTC host's own DNS domain in the list.
      const ownDomain = observed2.properties?.dtcHostNameDnsSuffix
        ?.split(".")
        .slice(1)
        .join(".")
        .toLowerCase();
      expect(ownDomain).toBeDefined();
      expect(
        (observed2.properties?.externalDnsSuffixSearchList ?? []).filter(
          (suffix) => suffix.toLowerCase() !== ownDomain,
        ),
      ).toEqual(["corp.example.com"]);

      // Removing the resource disables DTC.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.dtcEnabled === false,
          12,
        )).properties?.dtcEnabled,
      ).toEqual(false);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
