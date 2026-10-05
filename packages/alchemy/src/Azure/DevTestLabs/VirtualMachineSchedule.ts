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

export type VirtualMachineScheduleTaskType =
  | "LabVmsShutdownTask"
  | "LabVmsStartupTask";

export interface VirtualMachineScheduleProps extends ScheduleRecurrenceProps {
  /** Resource group of the lab. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the schedule. */
  lab: string;
  /** Name of the lab VM. Changing it replaces the schedule. */
  virtualMachine: string;
  /**
   * Task to run for the VM.
   * @default "LabVmsShutdownTask"
   */
  taskType?: VirtualMachineScheduleTaskType;
  /**
   * Schedule name. Lab VMs only honour `LabVmsShutdown` (shutdown) and
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

export interface VirtualMachineSchedule extends Resource<
  "Azure.DevTestLabs.VirtualMachineSchedule",
  VirtualMachineScheduleProps,
  ScheduleAttributes & {
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab VM. */
    virtualMachine: string;
  },
  never,
  Providers
> {}

/**
 * A per-VM schedule that overrides a DevTest Lab's shutdown
 * (`LabVmsShutdown`) or auto-start (`LabVmAutoStart`) schedule for one
 * lab VM.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-auto-shutdown
 *
 * ### Per-VM Auto-shutdown
 * **Example:** Shut one lab VM down at 22:00 UTC
 * ```typescript
 * const shutdown = yield* Azure.DevTestLabs.VirtualMachineSchedule("vm-off", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   virtualMachine: vm.virtualMachineName,
 *   dailyRecurrence: { time: "2200" },
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineSchedule = Resource<VirtualMachineSchedule>(
  "Azure.DevTestLabs.VirtualMachineSchedule",
);

const defaultName = (taskType: VirtualMachineScheduleTaskType) =>
  taskType === "LabVmsStartupTask" ? "LabVmAutoStart" : "LabVmsShutdown";

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  virtualMachineName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetVirtualMachineSchedule({
      subscriptionId,
      resourceGroupName,
      labName,
      virtualMachineName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  virtualMachine: string,
  name: string,
  s: devtestlabs.GetVirtualMachineScheduleResponse,
): VirtualMachineSchedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: s.id ?? "",
  resourceGroup,
  lab,
  virtualMachine,
  taskType: s.properties?.taskType ?? "",
  status: s.properties?.status ?? "",
  timeZoneId: s.properties?.timeZoneId,
  location: s.location ?? "",
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

export const VirtualMachineScheduleProvider = () =>
  Provider.succeed(VirtualMachineSchedule, {
    stables: [
      "scheduleName",
      "scheduleId",
      "resourceGroup",
      "lab",
      "virtualMachine",
      "location",
    ],

    // Schedules are deleted with their lab VM.
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
        news.virtualMachine.toLowerCase() !==
          output.virtualMachine.toLowerCase() ||
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
      const virtualMachine = output?.virtualMachine ?? olds?.virtualMachine;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        virtualMachine === undefined
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
        virtualMachine,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, virtualMachine, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, virtualMachine } = news;
      const taskType = news.taskType ?? "LabVmsShutdownTask";
      const name = news.name ?? output?.scheduleName ?? defaultName(taskType);
      const tags = yield* desiredTags(id, news.tags);
      const properties = scheduleInput({ ...news, taskType });

      // Observe.
      let observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        lab,
        virtualMachine,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.VirtualMachineSchedulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          virtualMachineName: virtualMachine,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, lab, virtualMachine, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteVirtualMachineSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          virtualMachineName: output.virtualMachine,
          name: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `lab VM schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.virtualMachine,
          output.scheduleName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
