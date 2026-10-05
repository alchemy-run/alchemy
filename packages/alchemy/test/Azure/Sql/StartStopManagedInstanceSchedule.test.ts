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
    return yield* sql.GetStartStopManagedInstanceSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      startStopScheduleName: "default",
    });
  });

type Step = {
  scheduleList: {
    startDay: "Monday" | "Tuesday";
    startTime: string;
    stopDay: "Monday" | "Tuesday";
    stopTime: string;
  }[];
};

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, instance } = yield* managedInstance(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.StartStopManagedInstanceSchedule("Setting", {
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
  "set, update, and remove a managed instance start/stop schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          scheduleList: [
            {
              startDay: "Monday",
              startTime: "08:00",
              stopDay: "Monday",
              stopTime: "18:00",
            },
          ],
        }),
      );
      const { group, instance } = first;
      const get = getSetting(
        group.resourceGroupName,
        instance.managedInstanceName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.scheduleList?.[0]?.startDay === "Monday",
        12,
      );
      expect(observed1.properties?.scheduleList).toHaveLength(1);

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          scheduleList: [
            {
              startDay: "Tuesday",
              startTime: "08:00",
              stopDay: "Tuesday",
              stopTime: "18:00",
            },
          ],
        }),
      );
      expect(second.setting?.scheduleId).toEqual(first.setting?.scheduleId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.scheduleList?.[0]?.startDay === "Tuesday",
        12,
      );
      expect(observed2.properties?.scheduleList?.[0]?.startDay).toEqual(
        "Tuesday",
      );

      // Removing the resource deletes the schedule.
      yield* stack.deploy(program(password, undefined));
      expect(yield* awaitGone(get)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
