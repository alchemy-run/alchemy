import * as hci from "@distilled.cloud/azure/azurestackhci";
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
  HCI_NAMESPACE,
  type HciExtendedLocation,
  isMachineStackOwned,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** OS profile of an Arc VM (admin credentials, computer name, OS settings). */
export type VirtualMachineInstanceOsProfile =
  hci.VirtualMachineInstancePropertiesOsProfile;
/** Security profile of an Arc VM (TPM, secure boot, security type). */
export type VirtualMachineInstanceSecurityProfile =
  hci.VirtualMachineInstancePropertiesInputSecurityProfile;
/** Dynamic memory settings of an Arc VM. */
export type VirtualMachineInstanceDynamicMemory =
  hci.VirtualMachineInstancePropertiesHardwareProfileDynamicMemoryConfig;
/** HTTP proxy settings of an Arc VM. */
export type VirtualMachineInstanceHttpProxy = hci.HttpProxyConfiguration;

export interface VirtualMachineInstanceHardwareProfile {
  /** VM size, e.g. `Default` or `Custom` (with processors and memory). */
  vmSize?: string;
  /** Number of virtual processors. */
  processors?: number;
  /** Memory in MB. */
  memoryMB?: number;
  /** Dynamic memory settings. Changing them replaces the VM. */
  dynamicMemoryConfig?: VirtualMachineInstanceDynamicMemory;
}

export interface VirtualMachineInstanceProps {
  /**
   * ARM ID of the Arc-enabled server (`Microsoft.HybridCompute/machines`,
   * kind `HCI`) this VM instance extends. Changing it replaces the VM.
   */
  machineId: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the VM.
   * Changing it replaces the VM.
   */
  extendedLocation: HciExtendedLocation;
  /** Size, processors, and memory of the VM. */
  hardwareProfile?: VirtualMachineInstanceHardwareProfile;
  /** ARM IDs of the Azure Local network interfaces attached to the VM. */
  networkInterfaceIds?: string[];
  /** ARM IDs of the Azure Local virtual hard disks attached as data disks. */
  dataDiskIds?: string[];
  /**
   * ARM ID of the gallery or marketplace image the OS disk is created
   * from. Changing it replaces the VM.
   */
  imageId?: string;
  /**
   * ARM ID of an existing virtual hard disk to boot from instead of an
   * image. Changing it replaces the VM.
   */
  osDiskId?: string;
  /**
   * ARM ID of the storage container that holds the VM configuration.
   * Changing it replaces the VM.
   */
  vmConfigStoragePathId?: string;
  /** OS profile. Changing it replaces the VM. */
  osProfile?: VirtualMachineInstanceOsProfile;
  /** Security profile. Changing it replaces the VM. */
  securityProfile?: VirtualMachineInstanceSecurityProfile;
  /** HTTP proxy configuration. Changing it replaces the VM. */
  httpProxyConfig?: VirtualMachineInstanceHttpProxy;
  /**
   * Give the VM a system-assigned managed identity. Changing it replaces
   * the VM.
   * @default false
   */
  systemAssignedIdentity?: boolean;
}

export interface VirtualMachineInstance extends Resource<
  "Azure.AzureStackHCI.VirtualMachineInstance",
  VirtualMachineInstanceProps,
  {
    /** ARM ID of the Arc-enabled server the VM instance extends. */
    machineId: string;
    /** ARM resource ID of the VM instance. */
    virtualMachineInstanceId: string;
    /** ARM ID of the Arc custom location that hosts the VM. */
    customLocationId: string | undefined;
    /** Unique ID of the VM on the cluster. */
    vmId: string | undefined;
    /** Power state of the VM. */
    powerState: string | undefined;
    /** Provisioning state of the VM. */
    provisioningState: string | undefined;
    /** Object ID of the VM's system-assigned identity, if any. */
    principalId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Arc virtual machine on an Azure Local cluster. Azure models it as the
 * singleton `virtualMachineInstances/default` extension of an Arc-enabled
 * server (`Microsoft.HybridCompute/machines`, kind `HCI`) and places it
 * through the cluster's Arc custom location.
 *
 * The VM instance has no tags of its own; Alchemy treats it as owned when
 * its Arc machine carries this stack's ownership tags. Size, network
 * interfaces, and data disks are updated in place; other settings replace
 * the VM.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/create-arc-virtual-machines
 *
 * ### Creating a VM
 * **Example:** Linux VM from a gallery image
 * ```typescript
 * const vm = yield* Azure.AzureStackHCI.VirtualMachineInstance("web", {
 *   machineId: arcMachineId,
 *   extendedLocation: { name: customLocationId },
 *   hardwareProfile: { vmSize: "Custom", processors: 2, memoryMB: 4096 },
 *   imageId: image.galleryImageId,
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   osProfile: {
 *     computerName: "web",
 *     adminUsername: "azureuser",
 *     linuxConfiguration: { disablePasswordAuthentication: true },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineInstance = Resource<VirtualMachineInstance>(
  "Azure.AzureStackHCI.VirtualMachineInstance",
);

const getInstance = (resourceUri: string) =>
  orUndefinedIfNotFound(hci.GetVirtualMachineInstance({ resourceUri }));

const toAttrs = (
  machineId: string,
  vm: hci.GetVirtualMachineInstanceResponse,
): VirtualMachineInstance["Attributes"] => ({
  machineId,
  virtualMachineInstanceId: vm.id ?? "",
  customLocationId: vm.extendedLocation?.name,
  vmId: vm.properties?.vmId,
  powerState: vm.properties?.status?.powerState,
  provisioningState: vm.properties?.provisioningState,
  principalId: vm.identity?.principalId,
});

const idList = (ids: readonly (string | undefined)[] | undefined) =>
  (ids ?? [])
    .flatMap((id) => (id === undefined ? [] : [id.toLowerCase()]))
    .sort();

const REPLACE_KEYS = [
  "imageId",
  "osDiskId",
  "vmConfigStoragePathId",
  "osProfile",
  "securityProfile",
  "httpProxyConfig",
  "systemAssignedIdentity",
] as const;

export const VirtualMachineInstanceProvider = () =>
  Provider.succeed(VirtualMachineInstance, {
    stables: ["machineId", "virtualMachineInstanceId", "vmId"],

    // VM instances are removed with their Arc machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.machineId, output.machineId) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          (REPLACE_KEYS.some((key) => !sameValue(news[key], olds[key])) ||
            !sameValue(
              news.hardwareProfile?.dynamicMemoryConfig,
              olds.hardwareProfile?.dynamicMemoryConfig,
            )))
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const machineId = output?.machineId ?? olds?.machineId;
      if (machineId === undefined) return undefined;
      const observed = yield* getInstance(machineId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(machineId, observed);
      return (yield* isMachineStackOwned(machineId)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { machineId } = news;
      const get = getInstance(machineId);
      // Creating a VM copies its image onto cluster storage.
      const settle = waitForProvisioned(
        `Arc VM ${machineId}`,
        get,
        (vm) => vm.properties?.provisioningState,
        { interval: "10 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* hci.VirtualMachineInstancesCreateOrUpdate({
          resourceUri: machineId,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          identity: news.systemAssignedIdentity
            ? { type: "SystemAssigned" }
            : undefined,
          properties: {
            hardwareProfile: news.hardwareProfile,
            networkProfile:
              news.networkInterfaceIds === undefined
                ? undefined
                : {
                    networkInterfaces: news.networkInterfaceIds.map((id) => ({
                      id,
                    })),
                  },
            storageProfile: {
              imageReference:
                news.imageId === undefined ? undefined : { id: news.imageId },
              osDisk:
                news.osDiskId === undefined ? undefined : { id: news.osDiskId },
              dataDisks: news.dataDiskIds?.map((id) => ({ id })),
              vmConfigStoragePathId: news.vmConfigStoragePathId,
            },
            osProfile: news.osProfile,
            securityProfile: news.securityProfile,
            httpProxyConfig: news.httpProxyConfig,
          },
        });
        observed = yield* settle;
      }

      // Sync size, network interfaces, and data disks against the observed VM.
      const current = observed.properties;
      const update: hci.VirtualMachineInstanceUpdateProperties = {};
      const hardware = news.hardwareProfile;
      if (
        hardware !== undefined &&
        ((hardware.vmSize !== undefined &&
          hardware.vmSize !== current?.hardwareProfile?.vmSize) ||
          (hardware.processors !== undefined &&
            hardware.processors !== current?.hardwareProfile?.processors) ||
          (hardware.memoryMB !== undefined &&
            hardware.memoryMB !== current?.hardwareProfile?.memoryMB))
      ) {
        update.hardwareProfile = {
          vmSize: hardware.vmSize,
          processors: hardware.processors,
          memoryMB: hardware.memoryMB,
        };
      }
      if (
        news.networkInterfaceIds !== undefined &&
        !sameValue(
          idList(news.networkInterfaceIds),
          idList(current?.networkProfile?.networkInterfaces?.map((n) => n.id)),
        )
      ) {
        update.networkProfile = {
          networkInterfaces: news.networkInterfaceIds.map((id) => ({ id })),
        };
      }
      if (
        news.dataDiskIds !== undefined &&
        !sameValue(
          idList(news.dataDiskIds),
          idList(current?.storageProfile?.dataDisks?.map((d) => d.id)),
        )
      ) {
        update.storageProfile = {
          dataDisks: news.dataDiskIds.map((id) => ({ id })),
        };
      }
      if (Object.keys(update).length > 0) {
        yield* hci.UpdateVirtualMachineInstance({
          resourceUri: machineId,
          properties: update,
        });
        observed = yield* settle;
      }

      return toAttrs(machineId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hci.DeleteVirtualMachineInstance({ resourceUri: output.machineId }),
      );
      yield* waitUntilGone(
        `Arc VM ${output.machineId}`,
        getInstance(output.machineId),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
