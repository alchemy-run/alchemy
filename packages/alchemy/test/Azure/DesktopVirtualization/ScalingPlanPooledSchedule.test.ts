import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (
  resourceGroupName: string,
  scalingPlanName: string,
  scalingPlanScheduleName: string,
) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetScalingPlanPooledSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      scalingPlanName,
      scalingPlanScheduleName,
    });
  });

const program = (props: { name?: string; rampUpHour: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const plan = yield* Azure.DesktopVirtualization.ScalingPlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location,
      timeZone: "UTC",
    });
    const schedule =
      yield* Azure.DesktopVirtualization.ScalingPlanPooledSchedule("Weekdays", {
        resourceGroup: group.resourceGroupName,
        scalingPlan: plan.scalingPlanName,
        name: props.name,
        daysOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        rampUpStartTime: { hour: props.rampUpHour, minute: 0 },
        rampUpMinimumHostsPct: 20,
        rampUpCapacityThresholdPct: 60,
        peakStartTime: { hour: 9, minute: 0 },
        rampDownStartTime: { hour: 18, minute: 0 },
        rampDownMinimumHostsPct: 10,
        rampDownCapacityThresholdPct: 90,
        rampDownForceLogoffUsers: false,
        rampDownStopHostsWhen: "ZeroSessions",
        rampDownWaitTimeMinutes: 30,
        rampDownNotificationMessage: "Please save your work.",
        offPeakStartTime: { hour: 20, minute: 0 },
      });
    return { group, plan, schedule };
  });

// Scaling plans and schedules are free metadata objects.
test.provider(
  "create, update, replace, and delete a pooled scaling plan schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, plan, schedule } = yield* stack.deploy(
        program({ rampUpHour: 7 }),
      );
      const get = (name: string) =>
        getSchedule(group.resourceGroupName, plan.scalingPlanName, name);
      const observed = yield* get(schedule.scheduleName);
      expect(observed.properties.rampUpStartTime).toEqual({
        hour: 7,
        minute: 0,
      });
      expect(observed.properties.daysOfWeek?.length).toEqual(5);
      expect(observed.properties.rampDownStopHostsWhen).toEqual("ZeroSessions");

      // In place: move ramp-up.
      const updated = yield* stack.deploy(program({ rampUpHour: 6 }));
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      expect(
        (yield* get(schedule.scheduleName)).properties.rampUpStartTime,
      ).toEqual({ hour: 6, minute: 0 });

      // Replacement: the schedule name is immutable. The new schedule
      // reuses the same weekdays, so the old one must be gone first — the
      // engine creates first, so use the deterministic name to verify.
      const replaced = yield* stack.deploy(
        program({ name: "weekdays", rampUpHour: 6 }),
      );
      expect(replaced.schedule.scheduleName).toEqual("weekdays");
      expect((yield* get("weekdays")).properties.rampUpStartTime).toEqual({
        hour: 6,
        minute: 0,
      });
      expect(yield* waitGone(get(schedule.scheduleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("weekdays"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
