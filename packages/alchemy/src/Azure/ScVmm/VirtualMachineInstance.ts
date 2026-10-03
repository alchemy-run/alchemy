import * as scvmm from "@distilled.cloud/azure/scvmm";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  isMachineStackOwned,
  SCVMM_NAMESPACE,
  type ScVmmExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** Where the VM comes from on the VMM server. */
export interface VirtualMachineInstanceInfrastructureProfile {
  /** ARM ID of the `Azure.ScVmm.VmmServer` that manages the VM. */
  vmmServerId?: string;
  /** ARM ID of the SCVMM cloud to deploy a new VM into. */
  cloudId?: string;
  /** ARM ID of the SCVMM VM template to deploy a new VM from. */
  templateId?: string;
  /** Name of the VM on the VMM server. */
  vmName?: string;
  /** Unique ID of an existing VM to onboard. */
  uuid?: string;
  /** ARM ID of the inventory item of an existing VM to onboard. */
  inventoryItemId?: string;
  /** VM generation (1 or 2). */
  generation?: number;
  /** Checkpoint type supported by the VM. Updated in place. */
  checkpointType?: string;
}

/** Guest OS settings applied when the VM is deployed. */
export interface VirtualMachineInstanceOsProfile {
  /** Administrator user name. */
  adminUsername?: string;
  /** Administrator password. Never returned by Azure. */
  adminPassword?: string | Redacted.Redacted<string>;
  /** Computer name of the guest. */
  computerName?: string;
  /** Active Directory domain to join. */
  domainName?: string;
  /** User name of an account allowed to join the domain. */
  domainUsername?: string;
  /** Password of the domain-join account. Never returned by Azure. */
  domainPassword?: string | Redacted.Redacted<string>;
  /** Workgroup to join instead of a domain. */
  workgroup?: string;
  /** Windows product key (`xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`). */
  productKey?: string;
  /** Index of the guest time zone. */
  timezone?: number;
  /** Semicolon-separated commands run once at first boot. */
  runOnceCommands?: string;
}

/** Processor and memory settings of the VM. Updated in place. */
export interface VirtualMachineInstanceHardwareProfile {
  /** Number of virtual CPUs. */
  cpuCount?: number;
  /** Memory in MB. */
  memoryMB?: number;
  /** Enable processor compatibility mode for live migration. */
  limitCpuForMigration?: boolean;
  /** Enable dynamic memory. */
  dynamicMemoryEnabled?: boolean;
  /** Maximum dynamic memory in MB. */
  dynamicMemoryMaxMB?: number;
  /** Minimum dynamic memory in MB. */
  dynamicMemoryMinMB?: number;
}

/** A network adapter of the VM. */
export interface VirtualMachineInstanceNetworkInterface {
  /** Name of the network adapter (used to match it against the VM). */
  name?: string;
  /** ARM ID of the `Microsoft.ScVmm/virtualNetworks` resource to connect to. */
  virtualNetworkId?: string;
  /** Static MAC address. */
  macAddress?: string;
  /** IPv4 address allocation. */
  ipv4AddressType?: "Dynamic" | "Static";
  /** IPv6 address allocation. */
  ipv6AddressType?: "Dynamic" | "Static";
  /** MAC address allocation. */
  macAddressType?: "Dynamic" | "Static";
  /** ID of an existing adapter on the VM. */
  nicId?: string;
}

/** A virtual disk of the VM. */
export interface VirtualMachineInstanceDisk {
  /** Name of the disk (used to match it against the VM). */
  name?: string;
  /** ID of an existing disk on the VM. */
  diskId?: string;
  /** Size of the disk in GB. */
  diskSizeGB?: number;
  /** Bus number. */
  bus?: number;
  /** Logical unit number. */
  lun?: number;
  /** Bus type, e.g. `SCSI` or `IDE`. */
  busType?: string;
  /** VHD type, e.g. `Dynamic` or `Fixed`. */
  vhdType?: string;
  /** ID of the template disk this disk is created from (create only). */
  templateDiskId?: string;
  /** Create a differencing disk (create only). */
  createDiffDisk?: boolean;
  /** Storage QoS policy of the disk. */
  storageQoSPolicy?: { id?: string; name?: string };
}

export interface VirtualMachineInstanceProps {
  /**
   * ARM ID of the Arc-enabled server (`Microsoft.HybridCompute/machines`,
   * kind `SCVMM`) this VM instance extends. Changing it replaces the VM.
   */
  machineId: string;
  /**
   * Arc custom location (Arc resource bridge) that fronts the VMM server.
   * Changing it replaces the VM.
   */
  extendedLocation: ScVmmExtendedLocation;
  /**
   * VMM server, cloud, template, or existing VM. Changing anything but
   * `checkpointType` replaces the VM.
   */
  infrastructureProfile?: VirtualMachineInstanceInfrastructureProfile;
  /** Guest OS settings. Changing them replaces the VM. */
  osProfile?: VirtualMachineInstanceOsProfile;
  /** CPU and memory. Updated in place. */
  hardwareProfile?: VirtualMachineInstanceHardwareProfile;
  /** Network adapters. Updated in place. */
  networkInterfaces?: VirtualMachineInstanceNetworkInterface[];
  /** Virtual disks. Updated in place. */
  disks?: VirtualMachineInstanceDisk[];
  /** ARM IDs of `Microsoft.ScVmm/availabilitySets` the VM belongs to. Updated in place. */
  availabilitySetIds?: string[];
  /**
   * Also delete the VM from the VMM server on destroy (otherwise only the
   * Azure projection is removed).
   * @default false
   */
  deleteFromHost?: boolean;
}

export interface VirtualMachineInstance extends Resource<
  "Azure.ScVmm.VirtualMachineInstance",
  VirtualMachineInstanceProps,
  {
    /** ARM ID of the Arc-enabled server the VM instance extends. */
    machineId: string;
    /** ARM resource ID of the VM instance. */
    virtualMachineInstanceId: string;
    /** ARM ID of the Arc custom location that fronts the VMM server. */
    customLocationId: string | undefined;
    /** Name of the VM on the VMM server. */
    vmName: string | undefined;
    /** Unique ID of the VM on the VMM server. */
    uuid: string | undefined;
    /** BIOS GUID of the VM. */
    biosGuid: string | undefined;
    /** Power state of the VM. */
    powerState: string | undefined;
    /** Provisioning state of the VM instance. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A virtual machine managed by an Arc-enabled System Center Virtual Machine
 * Manager. Azure models it as the singleton `virtualMachineInstances/default`
 * extension of an Arc-enabled server (`Microsoft.HybridCompute/machines`,
 * kind `SCVMM`) and reaches the VMM server through its Arc custom location.
 * It either deploys a new VM from a cloud + template or onboards an existing
 * VM (by `uuid` / `inventoryItemId`).
 *
 * The VM instance has no tags of its own; Alchemy treats it as owned when
 * its Arc machine carries this stack's ownership tags. CPU, memory, network
 * adapters, disks, availability sets, and checkpoint type are updated in
 * place; other settings replace the VM.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/system-center-virtual-machine-manager/create-virtual-machine
 *
 * ### Creating a VM
 * **Example:** Deploy a VM from an SCVMM template
 * ```typescript
 * const machine = yield* Azure.HybridCompute.Machine("vm", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "SCVMM",
 * });
 * const vm = yield* Azure.ScVmm.VirtualMachineInstance("vm", {
 *   machineId: machine.machineId,
 *   extendedLocation: { name: customLocationId },
 *   infrastructureProfile: {
 *     vmmServerId: vmm.vmmServerId,
 *     cloudId,
 *     templateId,
 *   },
 *   hardwareProfile: { cpuCount: 2, memoryMB: 4096 },
 * });
 * ```
 *
 * ### Removing the VM from the Host
 * **Example:** Delete the VM from SCVMM on destroy
 * ```typescript
 * yield* Azure.ScVmm.VirtualMachineInstance("vm", {
 *   machineId: machine.machineId,
 *   extendedLocation: { name: customLocationId },
 *   infrastructureProfile: { vmmServerId: vmm.vmmServerId, cloudId, templateId },
 *   deleteFromHost: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineInstance = Resource<VirtualMachineInstance>(
  "Azure.ScVmm.VirtualMachineInstance",
);

const getInstance = (resourceUri: string) =>
  orUndefinedIfNotFound(scvmm.GetVirtualMachineInstance({ resourceUri }));

const toAttrs = (
  machineId: string,
  vm: scvmm.GetVirtualMachineInstanceResponse,
): VirtualMachineInstance["Attributes"] => ({
  machineId,
  virtualMachineInstanceId: vm.id ?? "",
  customLocationId: vm.extendedLocation?.name,
  vmName: vm.properties?.infrastructureProfile?.vmName,
  uuid: vm.properties?.infrastructureProfile?.uuid,
  biosGuid: vm.properties?.infrastructureProfile?.biosGuid,
  powerState: vm.properties?.powerState,
  provisioningState: vm.properties?.provisioningState,
});

const flag = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? "true" : "false";

const flagOf = (value: string | undefined) =>
  value === undefined ? undefined : value.toLowerCase() === "true";

const idList = (ids: readonly (string | undefined)[] | undefined) =>
  (ids ?? [])
    .flatMap((id) => (id === undefined ? [] : [id.toLowerCase()]))
    .sort();

/** Whether every field the user set on `desired` matches `observed`. */
const matches = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
) =>
  observed !== undefined &&
  Object.entries(desired).every(([key, value]) =>
    value === undefined
      ? true
      : typeof value === "string" && typeof observed[key] === "string"
        ? sameId(value, observed[key] as string)
        : sameValue(value, observed[key]),
  );

const listDiffers = <D extends { name?: string }>(
  desired: readonly D[],
  observed: readonly Record<string, unknown>[] | undefined,
  project: (value: D) => Record<string, unknown>,
) =>
  desired.length !== (observed ?? []).length ||
  desired.some((item, index) => {
    const match =
      item.name === undefined
        ? observed?.[index]
        : observed?.find((o) => sameId(o.name as string, item.name));
    return !matches(project(item), match);
  });

const nicFields = ({
  name,
  virtualNetworkId,
  macAddress,
  ipv4AddressType,
  ipv6AddressType,
  macAddressType,
  nicId,
}: VirtualMachineInstanceNetworkInterface) => ({
  name,
  virtualNetworkId,
  macAddress,
  ipv4AddressType,
  ipv6AddressType,
  macAddressType,
  nicId,
});

const diskFields = ({
  name,
  diskId,
  diskSizeGB,
  bus,
  lun,
  busType,
  vhdType,
  storageQoSPolicy,
}: VirtualMachineInstanceDisk) => ({
  name,
  diskId,
  diskSizeGB,
  bus,
  lun,
  busType,
  vhdType,
  storageQoSPolicy,
});

const IMMUTABLE_INFRA_KEYS = [
  "vmmServerId",
  "cloudId",
  "templateId",
  "vmName",
  "uuid",
  "inventoryItemId",
  "generation",
] as const;

export const VirtualMachineInstanceProvider = () =>
  Provider.succeed(VirtualMachineInstance, {
    stables: ["machineId", "virtualMachineInstanceId", "uuid", "biosGuid"],

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
          (!sameValue(news.osProfile, olds.osProfile) ||
            IMMUTABLE_INFRA_KEYS.some(
              (key) =>
                !sameValue(
                  news.infrastructureProfile?.[key],
                  olds.infrastructureProfile?.[key],
                ),
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
      yield* ensureRegistered(subscriptionId, SCVMM_NAMESPACE);
      const { machineId } = news;
      const get = getInstance(machineId);
      // Deploying from a template copies its disks on the VMM host.
      const settle = waitForProvisioned(
        `SCVMM VM ${machineId}`,
        get,
        (vm) => vm.properties?.provisioningState,
        { interval: "10 seconds", times: 90 },
      );
      const hardware = news.hardwareProfile;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* scvmm.VirtualMachineInstancesCreateOrUpdate({
          resourceUri: machineId,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            infrastructureProfile: news.infrastructureProfile,
            osProfile: news.osProfile,
            hardwareProfile:
              hardware === undefined
                ? undefined
                : {
                    cpuCount: hardware.cpuCount,
                    memoryMB: hardware.memoryMB,
                    limitCpuForMigration: flag(hardware.limitCpuForMigration),
                    dynamicMemoryEnabled: flag(hardware.dynamicMemoryEnabled),
                    dynamicMemoryMaxMB: hardware.dynamicMemoryMaxMB,
                    dynamicMemoryMinMB: hardware.dynamicMemoryMinMB,
                  },
            networkProfile:
              news.networkInterfaces === undefined
                ? undefined
                : { networkInterfaces: news.networkInterfaces },
            storageProfile:
              news.disks === undefined ? undefined : { disks: news.disks },
            availabilitySets: news.availabilitySetIds?.map((id) => ({ id })),
          },
        });
        observed = yield* settle;
      }

      // Sync the mutable aspects against the observed VM.
      const current = observed.properties;
      const update: scvmm.VirtualMachineInstanceUpdateProperties = {};
      if (hardware !== undefined) {
        const observedHardware = current?.hardwareProfile;
        const desired = {
          cpuCount: hardware.cpuCount,
          memoryMB: hardware.memoryMB,
          limitCpuForMigration: hardware.limitCpuForMigration,
          dynamicMemoryEnabled: hardware.dynamicMemoryEnabled,
          dynamicMemoryMaxMB: hardware.dynamicMemoryMaxMB,
          dynamicMemoryMinMB: hardware.dynamicMemoryMinMB,
        };
        if (
          !matches(desired, {
            ...observedHardware,
            limitCpuForMigration: flagOf(observedHardware?.limitCpuForMigration),
            dynamicMemoryEnabled: flagOf(observedHardware?.dynamicMemoryEnabled),
          })
        ) {
          update.hardwareProfile = desired;
        }
      }
      if (
        news.networkInterfaces !== undefined &&
        listDiffers(
          news.networkInterfaces,
          current?.networkProfile?.networkInterfaces as
            | Record<string, unknown>[]
            | undefined,
          nicFields,
        )
      ) {
        update.networkProfile = {
          networkInterfaces: news.networkInterfaces.map(nicFields),
        };
      }
      if (
        news.disks !== undefined &&
        listDiffers(
          news.disks,
          current?.storageProfile?.disks as
            | Record<string, unknown>[]
            | undefined,
          diskFields,
        )
      ) {
        update.storageProfile = { disks: news.disks.map(diskFields) };
      }
      if (
        news.availabilitySetIds !== undefined &&
        !sameValue(
          idList(news.availabilitySetIds),
          idList(current?.availabilitySets?.map((set) => set.id)),
        )
      ) {
        update.availabilitySets = news.availabilitySetIds.map((id) => ({ id }));
      }
      const checkpointType = news.infrastructureProfile?.checkpointType;
      if (
        checkpointType !== undefined &&
        !sameId(checkpointType, current?.infrastructureProfile?.checkpointType)
      ) {
        update.infrastructureProfile = { checkpointType };
      }
      if (Object.keys(update).length > 0) {
        yield* scvmm.UpdateVirtualMachineInstance({
          resourceUri: machineId,
          properties: update,
        });
        observed = yield* settle;
      }

      return toAttrs(machineId, observed);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      yield* ignoreNotFound(
        scvmm.DeleteVirtualMachineInstance({
          resourceUri: output.machineId,
          deleteFromHost: olds?.deleteFromHost,
        }),
      );
      yield* waitUntilGone(
        `SCVMM VM ${output.machineId}`,
        getInstance(output.machineId),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
        "Azure.ScVmm.VmmServer",
      ],
    },
  });
