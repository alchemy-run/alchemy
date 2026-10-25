import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  diverges,
  scheduleInput,
  type ScheduleAttributes,
  type ScheduleRecurrenceProps,
} from "./Common.ts";

export interface ScheduleProps extends ScheduleRecurrenceProps {
  /**
   * Resource group of the schedule; must be the target VM's resource
   * group. Changing it replaces the schedule.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * ARM ID of the target resource, e.g. a `Compute.VirtualMachine`.
   * Changing it replaces the schedule.
   */
  targetResourceId: string;
  /**
   * Task to run.
   * @default "ComputeVmShutdownTask"
   */
  taskType?: string;
  /**
   * Schedule name. Azure requires `shutdown-computevm-<vmName>` for VM
   * auto-shutdown, which is the default for `ComputeVmShutdownTask`.
   * Changing it replaces the schedule.
   * @default `shutdown-computevm-<vmName>` for `ComputeVmShutdownTask`
   */
  name?: string;
  /**
   * Location of the schedule; must be the target VM's location. Changing
   * it replaces the schedule.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
   */
  tags?: Record<string, string>;
}

export interface Schedule extends Resource<
  "Azure.DevTestLabs.Schedule",
  ScheduleProps,
  ScheduleAttributes & {
    /** Resource group of the schedule. */
    resourceGroup: string;
    /** ARM ID of the target resource. */
    targetResourceId: string;
  },
  never,
  Providers
> {}

/**
 * An auto-shutdown (or other task) schedule for a regular Azure VM — what
 * the portal's VM "Auto-shutdown" blade creates. Lives in the VM's
 * resource group as `Microsoft.DevTestLab/schedules`; no lab is needed.
 *
 * :::caution
 * Changing `targetResourceId`, `taskType`, `name`, `location`, or
 * `resourceGroup` replaces the schedule.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/auto-shutdown-vm
 *
 * ### Auto-shutdown
 * **Example:** Shut a VM down every evening
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const nic = yield* Azure.Network.NetworkInterface("web", {
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("web", {
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 * });
 * const shutdown = yield* Azure.DevTestLabs.Schedule("vm-shutdown", {
 *   location: vm.location,
 *   targetResourceId: vm.virtualMachineId,
 *   dailyRecurrence: { time: "1900" },
 *   timeZoneId: "UTC",
 * });
 * ```
 *
 * **Example:** Email before shutdown
 * ```typescript
 * const shutdown = yield* Azure.DevTestLabs.Schedule("vm-shutdown", {
 *   location: vm.location,
 *   targetResourceId: vm.virtualMachineId,
 *   dailyRecurrence: { time: "1900" },
 *   notificationSettings: {
 *     status: "Enabled",
 *     timeInMinutes: 30,
 *     emailRecipient: "ops@example.com",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Schedule = GroupedResource<Schedule>("Azure.DevTestLabs.Schedule");

const DEFAULT_TASK = "ComputeVmShutdownTask";

const defaultName = (id: string, taskType: string, targetResourceId: string) =>
  taskType === DEFAULT_TASK
    ? Effect.succeed(`shutdown-computevm-${targetResourceId.split("/").pop()}`)
    : createLabResourceName(id);

const getSchedule = (subscriptionId: string, resourceGroupName: string, name: string) =>
  orUndefinedIfNotFound(devtestlabs.GetGlobalSchedule({ subscriptionId, resourceGroupName, name }));

const toAttrs = (
  resourceGroup: string,
  name: string,
  s: devtestlabs.GetGlobalScheduleResponse,
): Schedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: s.id ?? "",
  resourceGroup,
  targetResourceId: s.properties?.targetResourceId ?? "",
  taskType: s.properties?.taskType ?? "",
  status: s.properties?.status ?? "",
  timeZoneId: s.properties?.timeZoneId,
  location: s.location ?? "",
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["scheduleName", "scheduleId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(devtestlabs.ListGlobalScheduleBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((s) => {
        const group = resourceGroupOf(s.id);
        return hasAnyAlchemyTag(s.tags) && group !== undefined && s.name !== undefined
          ? [toAttrs(group, s.name, s)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.targetResourceId.toLowerCase() !== output.targetResourceId.toLowerCase() ||
        (news.taskType ?? DEFAULT_TASK) !== output.taskType ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.scheduleName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.scheduleName ??
        olds?.name ??
        (olds?.targetResourceId !== undefined
          ? yield* defaultName(id, olds.taskType ?? DEFAULT_TASK, olds.targetResourceId)
          : undefined);
      if (name === undefined) return undefined;
      const observed = yield* getSchedule(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const taskType = news.taskType ?? DEFAULT_TASK;
      const name =
        news.name ??
        output?.scheduleName ??
        (yield* defaultName(id, taskType, news.targetResourceId));
      const tags = yield* desiredTags(id, news.tags);
      const properties = scheduleInput({ ...news, taskType });

      // Observe.
      let observed = yield* getSchedule(subscriptionId, resourceGroup, name);

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.GlobalSchedulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name,
          location: observed?.location ?? news.location ?? output?.location ?? env.location,
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteGlobalSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `schedule ${output.scheduleName}`,
        getSchedule(subscriptionId, output.resourceGroup, output.scheduleName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
