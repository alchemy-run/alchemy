import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEVTESTLAB_NAMESPACE,
  diverges,
  labLocation,
  scheduleInput,
  type ScheduleAttributes,
  type ScheduleRecurrenceProps,
} from "./Common.ts";

export type LabScheduleTaskType = "LabVmsShutdownTask" | "LabVmsStartupTask";

export interface LabScheduleProps extends ScheduleRecurrenceProps {
  /** Resource group of the lab. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the schedule. */
  lab: string;
  /**
   * Task to run for every lab VM.
   * @default "LabVmsShutdownTask"
   */
  taskType?: LabScheduleTaskType;
  /**
   * Schedule name. Labs only honour `LabVmsShutdown` (shutdown) and
   * `LabVmAutoStart` (startup), which are the defaults for the task type.
   * Changing it replaces the schedule.
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface LabSchedule extends Resource<
  "Azure.DevTestLabs.LabSchedule",
  LabScheduleProps,
  ScheduleAttributes & {
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
  },
  never,
  Providers
> {}

/**
 * A lab-wide schedule that shuts down (`LabVmsShutdown`) or starts
 * (`LabVmAutoStart`) every VM in a DevTest Lab.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-set-lab-policy#set-auto-shutdown
 *
 * ### Lab Auto-shutdown
 * **Example:** Shut lab VMs down at 19:00 UTC
 * ```typescript
 * const shutdown = yield* Azure.DevTestLabs.LabSchedule("shutdown", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   dailyRecurrence: { time: "1900" },
 * });
 * ```
 *
 * ### Lab Auto-start
 * **Example:** Start lab VMs on weekday mornings
 * ```typescript
 * const start = yield* Azure.DevTestLabs.LabSchedule("start", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   taskType: "LabVmsStartupTask",
 *   weeklyRecurrence: {
 *     weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
 *     time: "0800",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const LabSchedule = Resource<LabSchedule>(
  "Azure.DevTestLabs.LabSchedule",
);

const defaultName = (taskType: LabScheduleTaskType) =>
  taskType === "LabVmsStartupTask" ? "LabVmAutoStart" : "LabVmsShutdown";

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetSchedule({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  s: devtestlabs.GetScheduleResponse,
): LabSchedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: s.id ?? "",
  resourceGroup,
  lab,
  taskType: s.properties?.taskType ?? "",
  status: s.properties?.status ?? "",
  timeZoneId: s.properties?.timeZoneId,
  location: s.location ?? "",
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

export const LabScheduleProvider = () =>
  Provider.succeed(LabSchedule, {
    stables: ["scheduleName", "scheduleId", "resourceGroup", "lab", "location"],

    // Schedules are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const taskType = news.taskType ?? "LabVmsShutdownTask";
      const name = news.name ?? defaultName(taskType);
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        taskType !== output.taskType ||
        name.toLowerCase() !== output.scheduleName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.scheduleName ??
        olds?.name ??
        defaultName(olds?.taskType ?? "LabVmsShutdownTask");
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        lab,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const taskType = news.taskType ?? "LabVmsShutdownTask";
      const name = news.name ?? output?.scheduleName ?? defaultName(taskType);
      const tags = yield* desiredTags(id, news.tags);
      const properties = scheduleInput({ ...news, taskType });

      // Observe.
      let observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        lab,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.SchedulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `lab schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.scheduleName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
