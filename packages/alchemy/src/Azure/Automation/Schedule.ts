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
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  sameName,
  sameText,
} from "./Common.ts";

export type ScheduleFrequency =
  | "OneTime"
  | "Day"
  | "Hour"
  | "Week"
  | "Month"
  | "Minute";

export type ScheduleDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface AdvancedSchedule {
  /** Days of the week, for `Week` schedules. */
  weekDays?: ScheduleDay[];
  /** Days of the month (1-31, or -1 for the last day), for `Month` schedules. */
  monthDays?: number[];
  /** Occurrences such as "the second Monday", for `Month` schedules. */
  monthlyOccurrences?: {
    /** Occurrence in the month (1-5, or -1 for the last). */
    occurrence: number;
    /** Day of the week. */
    day: ScheduleDay;
  }[];
}

export interface ScheduleProps {
  /** Resource group of the Automation account. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Automation account that holds the schedule. Changing it replaces the schedule. */
  automationAccount: string;
  /**
   * Schedule name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the schedule.
   */
  name?: string;
  /**
   * First run, as an ISO 8601 timestamp at least 5 minutes in the future
   * when the schedule is created. Changing it replaces the schedule.
   */
  startTime: string;
  /** How often the schedule recurs. Changing it replaces the schedule. */
  frequency: ScheduleFrequency;
  /**
   * Number of `frequency` units between runs (ignored for `OneTime`).
   * Changing it replaces the schedule.
   * @default 1
   */
  interval?: number;
  /**
   * IANA or Windows time zone the schedule is evaluated in. Changing it
   * replaces the schedule.
   * @default "UTC"
   */
  timeZone?: string;
  /**
   * Last run, as an ISO 8601 timestamp. Changing it replaces the schedule.
   * @default never expires
   */
  expiryTime?: string;
  /** Week/month day selection. Changing it replaces the schedule. */
  advancedSchedule?: AdvancedSchedule;
  /** Description of the schedule. */
  description?: string;
  /**
   * Whether the schedule triggers its linked runbooks.
   * @default true
   */
  isEnabled?: boolean;
}

export interface Schedule extends Resource<
  "Azure.Automation.Schedule",
  ScheduleProps,
  {
    /** Name of the schedule. */
    scheduleName: string;
    /** ARM resource ID of the schedule. */
    scheduleId: string;
    /** Automation account that holds the schedule. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Recurrence frequency. */
    frequency: string | undefined;
    /** First run. */
    startTime: string | undefined;
    /** Last run (`undefined` when the schedule never expires). */
    expiryTime: string | undefined;
    /** Next run. */
    nextRun: string | undefined;
    /** Whether the schedule is enabled. */
    isEnabled: boolean;
    /** Description of the schedule. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A schedule in an Azure Automation account. Link it to a runbook with a
 * {@link JobSchedule} to run the runbook on the schedule.
 *
 * Every timing field is immutable; changing one replaces the schedule.
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/schedules
 *
 * ### Creating a Schedule
 * **Example:** Daily at 02:00 UTC
 * ```typescript
 * const nightly = yield* Azure.Automation.Schedule("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   startTime: "2030-01-01T02:00:00Z",
 *   frequency: "Day",
 * });
 * ```
 *
 * **Example:** Every Monday and Friday
 * ```typescript
 * const weekly = yield* Azure.Automation.Schedule("weekly", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   startTime: "2030-01-01T08:00:00Z",
 *   frequency: "Week",
 *   advancedSchedule: { weekDays: ["Monday", "Friday"] },
 * });
 * ```
 *
 * @resource
 */
export const Schedule = Resource<Schedule>("Azure.Automation.Schedule");

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  scheduleName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetSchedule({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      scheduleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  schedule: automation.GetScheduleResponse,
): Schedule["Attributes"] => {
  const expiry = schedule.properties?.expiryTime ?? undefined;
  return {
    scheduleName: name,
    scheduleId: schedule.id ?? "",
    automationAccount,
    resourceGroup,
    frequency: schedule.properties?.frequency,
    startTime: schedule.properties?.startTime,
    // "Never expires" is reported as 9999-12-31.
    expiryTime: expiry?.startsWith("9999") ? undefined : expiry,
    nextRun: schedule.properties?.nextRun ?? undefined,
    isEnabled: schedule.properties?.isEnabled ?? false,
    description: schedule.properties?.description,
  };
};

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["scheduleName", "scheduleId", "automationAccount", "resourceGroup"],

    // Schedules live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.scheduleName)) ||
        news.frequency !== output.frequency ||
        (olds !== undefined &&
          (news.startTime !== olds.startTime ||
            (news.interval ?? 1) !== (olds.interval ?? 1) ||
            (news.timeZone ?? "UTC") !== (olds.timeZone ?? "UTC") ||
            news.expiryTime !== olds.expiryTime ||
            !sameJson(news.advancedSchedule, olds.advancedSchedule)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.scheduleName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.scheduleName ?? (yield* createChildName(id));
      const isEnabled = news.isEnabled ?? true;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        scheduleName: name,
      };
      const get = getSchedule(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Timing fields are fixed at creation.
      if (observed === undefined) {
        yield* automation.ScheduleCreateOrUpdate({
          ...where,
          name,
          properties: {
            startTime: news.startTime,
            frequency: news.frequency,
            interval: news.frequency === "OneTime" ? undefined : (news.interval ?? 1),
            timeZone: news.timeZone ?? "UTC",
            expiryTime: news.expiryTime,
            advancedSchedule: news.advancedSchedule,
            description: news.description,
          },
        });
        observed = yield* waitForProvisioned(
          `automation schedule ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the mutable aspects (description, enabled) against observed.
      if (
        !sameText(observed.properties?.description, news.description) ||
        observed.properties?.isEnabled !== isEnabled
      ) {
        observed = yield* automation.UpdateSchedule({
          ...where,
          name,
          properties: { description: news.description ?? "", isEnabled },
        });
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          scheduleName: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `automation schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.scheduleName,
        ),
      );
    }),

    nuke: childNuke,
  });
