import * as durabletask from "@distilled.cloud/azure/durabletask";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import { getScheduler } from "./Scheduler.ts";

export interface TaskHubProps {
  /**
   * Resource group of the scheduler. Changing it replaces the task hub.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the scheduler that holds the task hub
   * (`scheduler.schedulerName`). Changing it replaces the task hub.
   */
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
 * A task hub in a Durable Task Scheduler
 * (`Microsoft.DurableTask/schedulers/taskHubs`): the logical container for
 * one app's orchestration and activity state. Clients select it with the
 * `TaskHub=` value of the scheduler connection string.
 *
 * Task hubs cannot be tagged and have no settings; Alchemy treats one as
 * owned when its scheduler carries this stack's ownership tags. For Effect
 * workflows, `Azure.Functions.WorkflowFunction` creates its own task hub,
 * so you only declare one for the Durable Task SDKs or Durable Functions
 * you configure yourself. Alchemy waits up to 5 minutes for a new hub to
 * be ready. Destroy deletes the hub with every orchestration's state and
 * history, and waits up to 5 minutes; deleting its scheduler deletes the
 * hub too.
 *
 * :::caution[Changing `name`, `scheduler`, or `resourceGroup` replaces the task hub]
 * Alchemy creates a new, empty hub and deletes the old one with every
 * orchestration's state and history. Clients must switch to the new
 * `TaskHub=` value.
 * :::
 *
 * :::caution[The scheduler must exist first]
 * Create the hub on an `Azure.DurableTask.Scheduler` in a region that
 * offers schedulers (not `eastus`).
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Creating a Task Hub
 * **Example:** Task hub on a Consumption scheduler
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   scheduler: scheduler.schedulerName,
 * });
 * ```
 *
 * **Example:** Task hub with a fixed name
 * ```typescript
 * const hub = yield* Azure.DurableTask.TaskHub("orders", {
 *   scheduler: scheduler.schedulerName,
 *   name: "orders",
 * });
 * ```
 *
 * **Example:** One scheduler, one hub per app
 * ```typescript
 * const orders = yield* Azure.DurableTask.TaskHub("orders", {
 *   scheduler: scheduler.schedulerName,
 * });
 * const billing = yield* Azure.DurableTask.TaskHub("billing", {
 *   scheduler: scheduler.schedulerName,
 * });
 * ```
 *
 * ### Connecting a Client
 * The Durable Task SDKs and Durable Functions take an identity-based
 * connection string. There is no key.
 *
 * **Example:** Connection string for a system-assigned identity
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   scheduler: scheduler.schedulerName,
 * });
 * const connection = Output.interpolate`Endpoint=${scheduler.endpoint};Authentication=ManagedIdentity;TaskHub=${hub.taskHubName}`;
 * ```
 *
 * **Example:** Connection string for a user-assigned identity
 * ```typescript
 * const worker = yield* Azure.ManagedIdentity.UserAssignedIdentity("worker");
 * const connection = Output.interpolate`Endpoint=${scheduler.endpoint};Authentication=ManagedIdentity;ClientID=${worker.clientId};TaskHub=${hub.taskHubName}`;
 * ```
 *
 * ### Granting Access
 * Grant **Durable Task Data Contributor** on `taskHubId`. The role covers
 * this hub only; grant it on the scheduler's `schedulerId` for every hub.
 *
 * **Example:** Let a managed identity run orchestrations in the hub
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   scheduler: scheduler.schedulerName,
 * });
 * const worker = yield* Azure.ManagedIdentity.UserAssignedIdentity("worker");
 * yield* Azure.Authorization.RoleAssignment("worker-uses-hub", {
 *   scope: hub.taskHubId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.DurableTaskDataContributor,
 *   principalId: worker.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Binding to a runtime
 * `Azure.Functions.WorkflowFunction` creates a task hub for its runs and
 * grants its managed identity **Durable Task Data Contributor** on it.
 * `Azure.Functions.DurableEngine` grants a calling runtime the same role on
 * that hub only. A caller that isn't an Azure host (a Cloudflare Worker,
 * an AWS Lambda) gets an Entra service principal with the role.
 *
 * **Example:** Start runs on a workflow function's hub
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, location: "westus2" },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Functions.DurableEngine(OrderWorkflows))),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read a run and open the hub's dashboard
 * ```typescript
 * // init
 * const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *
 * // runtime: executionId is what an earlier `start` returned
 * const status = yield* placeOrder.get(executionId).status;
 *
 * // in the stack: the workflow function's hub
 * const { taskHub } = yield* OrderWorkflows.durableTask;
 * return { dashboard: taskHub.dashboardUrl };
 * ```
 *
 * @resource
 */
export const TaskHub = GroupedResource<TaskHub>("Azure.DurableTask.TaskHub");

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
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.scheduler.toLowerCase() !== output.scheduler.toLowerCase() ||
        (news.name !== undefined && news.name.toLowerCase() !== output.taskHubName.toLowerCase())
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
      const name = output?.taskHubName ?? olds?.name ?? (yield* createTaskHubName(id));
      const observed = yield* getTaskHub(subscriptionId, resourceGroup, scheduler, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scheduler, name, observed);
      const parent = yield* getScheduler(subscriptionId, resourceGroup, scheduler);
      const { stack, stage } = yield* stackAndStage;
      const tags = tagRecord(parent?.tags);
      return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DurableTask");
      const { resourceGroup, scheduler } = news;
      const name = news.name ?? output?.taskHubName ?? (yield* createTaskHubName(id));
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
        getTaskHub(subscriptionId, output.resourceGroup, output.scheduler, output.taskHubName),
        { interval: "3 seconds", times: 100 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DurableTask.Scheduler"],
    },
  });
