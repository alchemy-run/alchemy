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

const program = (props: { startTime: string; mode: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const runbook = yield* Azure.Automation.Runbook("Runbook", {
      ...where,
      runbookType: "PowerShell72",
      content: "param([string]$mode) Write-Output $mode",
    });
    const schedule = yield* Azure.Automation.Schedule("Schedule", {
      ...where,
      startTime: props.startTime,
      frequency: "Day",
    });
    const link = yield* Azure.Automation.JobSchedule("Link", {
      ...where,
      runbook: runbook.runbookName,
      schedule: schedule.scheduleName,
      // Azure stores parameter names capitalized.
      parameters: { Mode: props.mode },
    });
    return { where, runbook, schedule, link };
  });

const getLink = (
  resourceGroupName: string,
  automationAccountName: string,
  jobScheduleId: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetJobSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      jobScheduleId,
    });
  });

// Free: the schedule starts tomorrow, so no job runs during the test.
test.provider(
  "create, replace, and delete a job schedule",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();
        const startTime = new Date(Date.now() + 24 * 3600_000)
          .toISOString()
          .replace(/\.\d+Z$/, "Z");

        const { where, runbook, schedule, link } = yield* stack.deploy(
          program({ startTime, mode: "dry" }),
        );
        const get = (jobScheduleId: string) =>
          getLink(where.resourceGroup, where.automationAccount, jobScheduleId);
        const observed = yield* get(link.jobScheduleId);
        expect(observed.properties?.runbook?.name).toEqual(runbook.runbookName);
        expect(observed.properties?.schedule?.name).toEqual(
          schedule.scheduleName,
        );
        expect(observed.properties?.parameters?.Mode).toEqual("dry");

        // Replacement (delete-first): parameters are immutable.
        const replaced = yield* stack.deploy(
          program({ startTime, mode: "live" }),
        );
        expect(replaced.link.jobScheduleId).not.toEqual(link.jobScheduleId);
        expect(
          (yield* get(replaced.link.jobScheduleId)).properties?.parameters
            ?.Mode,
        ).toEqual("live");
        expect(yield* waitGone(get(link.jobScheduleId))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.link.jobScheduleId))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
