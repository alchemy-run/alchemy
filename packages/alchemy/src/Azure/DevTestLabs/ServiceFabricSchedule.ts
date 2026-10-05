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

export type ServiceFabricScheduleTaskType =
  | "LabVmsShutdownTask"
  | "LabVmsStartupTask";

export interface ServiceFabricScheduleProps extends ScheduleRecurrenceProps {
  /** Resource group of the lab. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the schedule. */
  lab: string;
  /** Name of the lab user that owns the cluster. Changing it replaces the schedule. */
  user: string;
  /** Name of the lab Service Fabric registration. Changing it replaces the schedule. */
  serviceFabric: string;
  /**
   * Task to run for the cluster.
   * @default "LabVmsShutdownTask"
   */
  taskType?: ServiceFabricScheduleTaskType;
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

export interface ServiceFabricSchedule extends Resource<
  "Azure.DevTestLabs.ServiceFabricSchedule",
  ServiceFabricScheduleProps,
  ScheduleAttributes & {
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab user that owns the cluster. */
    user: string;
    /** Name of the lab Service Fabric registration. */
    serviceFabric: string;
  },
  never,
  Providers
> {}

/**
 * A shutdown (`LabVmsShutdown`) or auto-start (`LabVmAutoStart`) schedule
 * for a Service Fabric cluster registered with a DevTest Labs user.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/create-environment-service-fabric-cluster
 *
 * ### Cluster Auto-shutdown
 * **Example:** Stop the cluster every evening
 * ```typescript
 * const shutdown = yield* Azure.DevTestLabs.ServiceFabricSchedule("off", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   serviceFabric: fabric.serviceFabricName,
 *   dailyRecurrence: { time: "1900" },
 * });
 * ```
 *
 * @resource
 */
export const ServiceFabricSchedule = Resource<ServiceFabricSchedule>(
  "Azure.DevTestLabs.ServiceFabricSchedule",
);

const defaultName = (taskType: ServiceFabricScheduleTaskType) =>
  taskType === "LabVmsStartupTask" ? "LabVmAutoStart" : "LabVmsShutdown";

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  userName: string,
  serviceFabricName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetServiceFabricSchedule({
      subscriptionId,
      resourceGroupName,
      labName,
      userName,
      serviceFabricName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  user: string,
  serviceFabric: string,
  name: string,
  s: devtestlabs.GetServiceFabricScheduleResponse,
): ServiceFabricSchedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: s.id ?? "",
  resourceGroup,
  lab,
  user,
  serviceFabric,
  taskType: s.properties?.taskType ?? "",
  status: s.properties?.status ?? "",
  timeZoneId: s.properties?.timeZoneId,
  location: s.location ?? "",
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

export const ServiceFabricScheduleProvider = () =>
  Provider.succeed(ServiceFabricSchedule, {
    stables: [
      "scheduleName",
      "scheduleId",
      "resourceGroup",
      "lab",
      "user",
      "serviceFabric",
      "location",
    ],

    // Schedules are deleted with their Service Fabric registration.
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
        news.user.toLowerCase() !== output.user.toLowerCase() ||
        news.serviceFabric.toLowerCase() !==
          output.serviceFabric.toLowerCase() ||
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
      const user = output?.user ?? olds?.user;
      const serviceFabric = output?.serviceFabric ?? olds?.serviceFabric;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        user === undefined ||
        serviceFabric === undefined
      ) {
        return undefined;
      }
      const name =
        output?.scheduleName ??
        olds?.name ??
        defaultName(olds?.taskType ?? "LabVmsShutdownTask");
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        serviceFabric,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        lab,
        user,
        serviceFabric,
        name,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, user, serviceFabric } = news;
      const taskType = news.taskType ?? "LabVmsShutdownTask";
      const name = news.name ?? output?.scheduleName ?? defaultName(taskType);
      const tags = yield* desiredTags(id, news.tags);
      const properties = scheduleInput({ ...news, taskType });

      // Observe.
      let observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        serviceFabric,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.ServiceFabricSchedulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          userName: user,
          serviceFabricName: serviceFabric,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
      }

      return toAttrs(
        resourceGroup,
        lab,
        user,
        serviceFabric,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteServiceFabricSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          userName: output.user,
          serviceFabricName: output.serviceFabric,
          name: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `service fabric schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.user,
          output.serviceFabric,
          output.scheduleName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
