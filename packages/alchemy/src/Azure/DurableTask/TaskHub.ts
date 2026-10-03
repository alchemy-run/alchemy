import * as durabletask from "@distilled.cloud/azure/durabletask";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getScheduler } from "./Scheduler.ts";

export interface TaskHubProps {
  /** Resource group of the scheduler. Changing it replaces the task hub. */
  resourceGroup: string;
  /** Scheduler that holds the task hub. Changing it replaces the task hub. */
  scheduler: string;
  /**
   * Task hub name: 3-64 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the task hub.
   */
  name?: string;
}

export interface TaskHub extends Resource<
  "Azure.DurableTask.TaskHub",
  TaskHubProps,
  {
    /** Name of the task hub (the `TaskHub=` connection-string value). */
    taskHubName: string;
    /** Scheduler that holds the task hub. */
    scheduler: string;
    /** Resource group of the scheduler. */
    resourceGroup: string;
    /** ARM resource ID of the task hub; use it as a role-assignment scope. */
    taskHubId: string;
    /** URL of the Durable Task Scheduler dashboard for this hub. */
    dashboardUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A task hub in a Durable Task Scheduler — the logical container for one
 * app's orchestration and activity state. Clients select it with the
 * `TaskHub=` value of the scheduler connection string.
 *
 * Task hubs cannot be tagged and have no settings; Alchemy treats one as
 * owned when its scheduler carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Creating a Task Hub
 * **Example:** Task hub on a Consumption scheduler
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   resourceGroup: group.resourceGroupName,
 *   scheduler: scheduler.schedulerName,
 * });
 * ```
 *
 * **Example:** Connection string for a Durable Task client
 * ```typescript
 * const connection = Output.interpolate`Endpoint=${scheduler.endpoint};Authentication=ManagedIdentity;TaskHub=${hub.taskHubName}`;
 * ```
 *
 * @resource
 */
export const TaskHub = Resource<TaskHub>("Azure.DurableTask.TaskHub");

const createTaskHubName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true, delimiter: "-" });

const getTaskHub = (
  subscriptionId: string,
  resourceGroupName: string,
  schedulerName: string,
  taskHubName: string,
) =>
  orUndefinedIfNotFound(
    durabletask.GetTaskHub({
      subscriptionId,
      resourceGroupName,
      schedulerName,
      taskHubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  scheduler: string,
  name: string,
  hub: durabletask.GetTaskHubResponse,
): TaskHub["Attributes"] => ({
  taskHubName: name,
  scheduler,
  resourceGroup,
  taskHubId: hub.id ?? "",
  dashboardUrl: hub.properties?.dashboardUrl,
});

export const TaskHubProvider = () =>
  Provider.succeed(TaskHub, {
    stables: ["taskHubName", "scheduler", "resourceGroup", "taskHubId"],

    // Task hubs live inside a scheduler; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.scheduler.toLowerCase() !== output.scheduler.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.taskHubName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scheduler = output?.scheduler ?? olds?.scheduler;
      if (resourceGroup === undefined || scheduler === undefined) {
        return undefined;
      }
      const name =
        output?.taskHubName ?? olds?.name ?? (yield* createTaskHubName(id));
      const observed = yield* getTaskHub(
        subscriptionId,
        resourceGroup,
        scheduler,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scheduler, name, observed);
      const parent = yield* getScheduler(
        subscriptionId,
        resourceGroup,
        scheduler,
      );
      const { stack, stage } = yield* stackAndStage;
      const tags = tagRecord(parent?.tags);
      return tags["alchemy::stack"] === stack &&
        tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DurableTask");
      const { resourceGroup, scheduler } = news;
      const name =
        news.name ?? output?.taskHubName ?? (yield* createTaskHubName(id));
      const get = getTaskHub(subscriptionId, resourceGroup, scheduler, name);

      // Observe; ensure (existence-only — a task hub has no settings).
      const observed = yield* get;
      if (observed === undefined) {
        yield* durabletask.TaskHubsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schedulerName: scheduler,
          taskHubName: name,
          properties: {},
        });
      }
      const ready = yield* waitForProvisioned(
        `durable task hub ${name}`,
        get,
        (hub) => hub.properties?.provisioningState,
        { interval: "3 seconds", times: 100 },
      );
      return toAttrs(resourceGroup, scheduler, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        durabletask.DeleteTaskHub({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schedulerName: output.scheduler,
          taskHubName: output.taskHubName,
        }),
      );
      yield* waitUntilGone(
        `durable task hub ${output.taskHubName}`,
        getTaskHub(
          subscriptionId,
          output.resourceGroup,
          output.scheduler,
          output.taskHubName,
        ),
        { interval: "3 seconds", times: 100 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DurableTask.Scheduler",
      ],
    },
  });
