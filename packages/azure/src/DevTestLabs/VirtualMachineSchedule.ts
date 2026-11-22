import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  DEVTESTLAB_NAMESPACE,
  diverges,
  labLocation,
  scheduleInput,
  type ScheduleAttributes,
  type ScheduleRecurrenceProps,
} from "./Common.ts";

export type VirtualMachineScheduleTaskType = "LabVmsShutdownTask" | "LabVmsStartupTask";

export interface VirtualMachineScheduleProps extends ScheduleRecurrenceProps {
  /**
   * Resource group of the lab. Changing it replaces the schedule.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
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
   * @default `LabVmsShutdown` or `LabVmAutoStart`, from `taskType`
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
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
 * A per-VM schedule (`Microsoft.DevTestLab/labs/virtualmachines/schedules`)
 * that overrides a DevTest Lab's shutdown
 * (`LabVmsShutdown`) or auto-start (`LabVmAutoStart`) schedule for one
 * lab VM.
 *
 * :::caution
 * Changing `lab`, `virtualMachine`, `name`, `taskType`, or
 * `resourceGroup` replaces the schedule.
 * :::
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-auto-shutdown
 *
 * ### Per-VM Auto-shutdown
 * **Example:** Shut one lab VM down at 22:00 UTC
 * ```typescript
 * const lab = yield* Azure.DevTestLabs.Lab("team-lab");
 * const vnet = yield* Azure.Network.VirtualNetwork("lab-vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("lab-vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const network = yield* Azure.DevTestLabs.LabVirtualNetwork("net", {
 *   lab: lab.labName,
 *   externalProviderResourceId: vnet.virtualNetworkId,
 *   subnetOverrides: [
 *     {
 *       resourceId: subnet.subnetId,
 *       labSubnetName: subnet.subnetName,
 *       useInVmCreationPermission: "Allow",
 *     },
 *   ],
 * });
 * const publicKey = "ssh-ed25519 AAAAC3Nza... me@example.com";
 * const vm = yield* Azure.DevTestLabs.VirtualMachine("dev", {
 *   lab: lab.labName,
 *   size: "Standard_B1s",
 *   galleryImageReference: {
 *     publisher: "Canonical",
 *     offer: "0001-com-ubuntu-server-jammy",
 *     sku: "22_04-lts-gen2",
 *     osType: "Linux",
 *   },
 *   userName: "azureuser",
 *   isAuthenticationWithSshKey: true,
 *   sshKey: publicKey,
 *   labVirtualNetworkId: network.labVirtualNetworkId,
 *   labSubnetName: subnet.subnetName,
 * });
 * const shutdown = yield* Azure.DevTestLabs.VirtualMachineSchedule("vm-off", {
 *   lab: lab.labName,
 *   virtualMachine: vm.virtualMachineName,
 *   dailyRecurrence: { time: "2200" },
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineSchedule = GroupedResource<VirtualMachineSchedule>(
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
    stables: ["scheduleName", "scheduleId", "resourceGroup", "lab", "virtualMachine", "location"],

    // Schedules are deleted with their lab VM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const taskType = news.taskType ?? "LabVmsShutdownTask";
      const name = news.name ?? defaultName(taskType);
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.virtualMachine.toLowerCase() !== output.virtualMachine.toLowerCase() ||
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
      if (resourceGroup === undefined || lab === undefined || virtualMachine === undefined) {
        return undefined;
      }
      const name =
        output?.scheduleName ?? olds?.name ?? defaultName(olds?.taskType ?? "LabVmsShutdownTask");
      const observed = yield* getSchedule(subscriptionId, resourceGroup, lab, virtualMachine, name);
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
      let observed = yield* getSchedule(subscriptionId, resourceGroup, lab, virtualMachine, name);

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
          location: observed?.location ?? (yield* labLocation(subscriptionId, resourceGroup, lab)),
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
