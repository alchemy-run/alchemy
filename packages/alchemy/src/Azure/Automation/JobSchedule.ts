import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { deterministicGuid } from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStage,
  childNuke,
  sameName,
  sameRecord,
} from "./Common.ts";

export interface JobScheduleProps {
  /** Resource group of the Automation account. Changing it replaces the link. */
  resourceGroup: string;
  /** Automation account that holds the runbook and schedule. Changing it replaces the link. */
  automationAccount: string;
  /** Published {@link Runbook} to run. Changing it replaces the link. */
  runbook: string;
  /** {@link Schedule} that triggers the runbook. Changing it replaces the link. */
  schedule: string;
  /** Runbook parameters for every scheduled job. Changing them replaces the link. */
  parameters?: Record<string, string>;
  /**
   * Name of a {@link HybridRunbookWorkerGroup} to run the jobs on. Omit to
   * run them in Azure. Changing it replaces the link.
   */
  runOn?: string;
}

export interface JobSchedule extends Resource<
  "Azure.Automation.JobSchedule",
  JobScheduleProps,
  {
    /** Job schedule ID (a GUID). */
    jobScheduleId: string;
    /** ARM resource ID of the job schedule. */
    jobScheduleResourceId: string;
    /** Automation account that holds the job schedule. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Linked runbook. */
    runbook: string;
    /** Linked schedule. */
    schedule: string;
  },
  never,
  Providers
> {}

/**
 * Links a {@link Runbook} to a {@link Schedule} so the schedule starts the
 * runbook. A runbook/schedule pair can be linked only once, and links
 * cannot be updated: any change deletes the old link before creating the
 * new one.
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/schedules#link-a-schedule-to-a-runbook
 *
 * ### Scheduling a Runbook
 * **Example:** Run a runbook nightly
 * ```typescript
 * const nightly = yield* Azure.Automation.Schedule("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   startTime: "2030-01-01T02:00:00Z",
 *   frequency: "Day",
 * });
 * yield* Azure.Automation.JobSchedule("cleanup-nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runbook: cleanup.runbookName,
 *   schedule: nightly.scheduleName,
 *   parameters: { dryRun: "false" },
 * });
 * ```
 *
 * @resource
 */
export const JobSchedule = Resource<JobSchedule>(
  "Azure.Automation.JobSchedule",
);

const getJobSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  jobScheduleId: string,
) =>
  orUndefinedIfNotFound(
    automation.GetJobSchedule({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      jobScheduleId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  jobScheduleId: string,
  link: automation.GetJobScheduleResponse,
): JobSchedule["Attributes"] => ({
  jobScheduleId,
  jobScheduleResourceId: link.id ?? "",
  automationAccount,
  resourceGroup,
  runbook: link.properties?.runbook?.name ?? "",
  schedule: link.properties?.schedule?.name ?? "",
});

export const JobScheduleProvider = () =>
  Provider.succeed(JobSchedule, {
    stables: [
      "jobScheduleId",
      "jobScheduleResourceId",
      "automationAccount",
      "resourceGroup",
      "runbook",
      "schedule",
    ],

    // Job schedules live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.runbook, output.runbook) ||
        !sameName(news.schedule, output.schedule) ||
        (olds !== undefined &&
          (!sameRecord(news.parameters, olds.parameters) ||
            news.runOn !== olds.runOn))
      ) {
        // The runbook/schedule pair is unique, so the old link must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const jobScheduleId =
        output?.jobScheduleId ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getJobSchedule(
        subscriptionId,
        resourceGroup,
        account,
        jobScheduleId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, jobScheduleId, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    // Existence-only: there is no update API.
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const jobScheduleId =
        output?.jobScheduleId ?? (yield* deterministicGuid(id, instanceId));
      const get = getJobSchedule(
        subscriptionId,
        resourceGroup,
        automationAccount,
        jobScheduleId,
      );

      // Observe → ensure.
      if ((yield* get) === undefined) {
        yield* automation.CreateJobSchedule({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          jobScheduleId,
          properties: {
            runbook: { name: news.runbook },
            schedule: { name: news.schedule },
            parameters: news.parameters,
            runOn: news.runOn,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `job schedule ${jobScheduleId}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, automationAccount, jobScheduleId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteJobSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          jobScheduleId: output.jobScheduleId,
        }),
      );
      yield* waitUntilGone(
        `job schedule ${output.jobScheduleId}`,
        getJobSchedule(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.jobScheduleId,
        ),
      );
    }),

    nuke: childNuke,
  });
