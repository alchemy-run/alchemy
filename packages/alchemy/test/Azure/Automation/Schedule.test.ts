import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  startTime: string;
  frequency: Azure.Automation.ScheduleFrequency;
  isEnabled?: boolean;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const schedule = yield* Azure.Automation.Schedule("Schedule", {
      ...where,
      startTime: props.startTime,
      frequency: props.frequency,
      isEnabled: props.isEnabled,
      description: props.description,
    });
    return { where, schedule };
  });

const getSchedule = (
  resourceGroupName: string,
  automationAccountName: string,
  scheduleName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      scheduleName,
    });
  });

// Free: an Automation account plus one schedule, seconds to provision.
test.provider(
  "create, update, replace, and delete a schedule",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();
        // Schedules must start at least 5 minutes in the future.
        const startTime = new Date(Date.now() + 24 * 3600_000)
          .toISOString()
          .replace(/\.\d+Z$/, "Z");

        const { where, schedule } = yield* stack.deploy(
          program({ startTime, frequency: "Day", description: "daily" }),
        );
        const get = (name: string) =>
          getSchedule(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(schedule.scheduleName);
        expect(observed.properties?.frequency).toEqual("Day");
        expect(observed.properties?.isEnabled).toEqual(true);
        expect(observed.properties?.description).toEqual("daily");

        // In-place: disable and re-describe.
        const updated = yield* stack.deploy(
          program({
            startTime,
            frequency: "Day",
            isEnabled: false,
            description: "paused",
          }),
        );
        expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
        const reobserved = yield* get(schedule.scheduleName);
        expect(reobserved.properties?.isEnabled).toEqual(false);
        expect(reobserved.properties?.description).toEqual("paused");

        // Replacement: frequency is immutable.
        const replaced = yield* stack.deploy(
          program({
            startTime,
            frequency: "Week",
            isEnabled: false,
            description: "paused",
          }),
        );
        expect(replaced.schedule.scheduleName).not.toEqual(
          schedule.scheduleName,
        );
        expect(
          (yield* get(replaced.schedule.scheduleName)).properties?.frequency,
        ).toEqual("Week");
        expect(yield* waitGone(get(schedule.scheduleName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.schedule.scheduleName))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
