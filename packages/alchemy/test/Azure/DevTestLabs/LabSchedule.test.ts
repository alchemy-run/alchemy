import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: {
  time: string;
  status: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const schedule = yield* Azure.DevTestLabs.LabSchedule("Shutdown", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      dailyRecurrence: { time: props.time },
      status: props.status,
      timeZoneId: "UTC",
      tags: { purpose: "test" },
    });
    return { group, lab, schedule };
  });

// Free lab + schedule; ~5 minutes for the lab.
test.provider(
  "create, update, and delete a lab schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, schedule } = yield* stack.deploy(
        program({ time: "1900", status: "Enabled" }),
      );
      expect(schedule.scheduleName).toEqual("LabVmsShutdown");
      expect(schedule.location.toLowerCase()).toEqual(lab.location.toLowerCase());
      const get = () =>
        getSchedule(group.resourceGroupName, lab.labName, schedule.scheduleName);
      const observed = yield* get();
      expect(observed.properties?.dailyRecurrence?.time).toEqual("1900");
      expect(observed.properties?.taskType).toEqual("LabVmsShutdownTask");
      expect(observed.tags?.["alchemy::id"]).toEqual("Shutdown");

      // In-place: time + status.
      const updated = yield* stack.deploy(
        program({ time: "2030", status: "Disabled" }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* get();
      expect(reobserved.properties?.dailyRecurrence?.time).toEqual("2030");
      expect(reobserved.properties?.status).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
