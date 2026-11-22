import * as hci from "@distilled.cloud/azure/azurestackhci";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  HCI_NAMESPACE,
  type HciExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

export interface VirtualHardDiskProps {
  /** Resource group the virtual hard disk is created in. Changing it replaces the virtual hard disk. */
  resourceGroup: string;
  /**
   * Name of the virtual hard disk. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the virtual hard disk.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure region of the virtual hard disk; must match the custom location's region.
   * Changing it replaces the virtual hard disk.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the virtual hard disk.
   * Changing it replaces the virtual hard disk.
   */
  extendedLocation: HciExtendedLocation;
  /**
   * Size of the disk in GB. Changing it replaces the disk.
   * @default not set
   */
  diskSizeGB?: number;
  /**
   * Whether the disk is dynamically expanding. Changing it replaces the disk.
   * @default not set (Azure's default applies)
   */
  dynamic?: boolean;
  /**
   * Block size in bytes. Changing it replaces the disk.
   * @default not set
   */
  blockSizeBytes?: number;
  /**
   * Logical sector size in bytes. Changing it replaces the disk.
   * @default not set
   */
  logicalSectorBytes?: number;
  /**
   * Physical sector size in bytes. Changing it replaces the disk.
   * @default not set
   */
  physicalSectorBytes?: number;
  /**
   * Hyper-V generation. Changing it replaces the disk.
   * @default not set
   */
  hyperVGeneration?: "V1" | "V2";
  /**
   * Disk file format. Changing it replaces the disk.
   * @default not set
   */
  diskFileFormat?: "vhdx" | "vhd";
  /**
   * ARM ID of the storage container that stores the disk. Changing it
   * replaces the disk.
   * @default the cluster's default storage path
   */
  containerId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface VirtualHardDisk extends Resource<
  "Azure.AzureStackHCI.VirtualHardDisk",
  VirtualHardDiskProps,
  {
    /** Name of the virtual hard disk. */
    virtualHardDiskName: string;
    /** Resource group that holds the virtual hard disk. */
    resourceGroup: string;
    /** ARM resource ID of the virtual hard disk. */
    virtualHardDiskId: string;
    /** Azure region of the virtual hard disk. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the virtual hard disk. */
    customLocationId: string | undefined;
    /** Provisioning state of the virtual hard disk. */
    provisioningState: string | undefined;
    /** Size of the disk in GB. */
    diskSizeGB: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A data disk on an Azure Local cluster that can be attached to an Arc
 * VM. Needs an Arc custom location backed by the Arc Resource Bridge of a
 * deployed Azure Local cluster.
 * The ARM type is `Microsoft.AzureStackHCI/virtualHardDisks`.
 *
 * :::caution
 * Changing `name`, `location`, `extendedLocation`, `diskSizeGB`, `dynamic`,
 * `blockSizeBytes`, `logicalSectorBytes`, `physicalSectorBytes`,
 * `hyperVGeneration`, `diskFileFormat`, `containerId`, or `resourceGroup`
 * replaces the disk.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/manage-arc-virtual-machine-resources
 *
 * ### Creating a Data Disk
 * **Example:** Dynamically expanding 64 GB disk
 * ```typescript
 * // Arc custom location of the Azure Local cluster.
 * const customLocationId = yield* Config.string("HCI_CUSTOM_LOCATION_ID");
 * const disk = yield* Azure.AzureStackHCI.VirtualHardDisk("data", {
 *   extendedLocation: { name: customLocationId },
 *   diskSizeGB: 64,
 *   dynamic: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualHardDisk = GroupedResource<VirtualHardDisk>(
  "Azure.AzureStackHCI.VirtualHardDisk",
);

const SPEC_KEYS = [
  "diskSizeGB",
  "dynamic",
  "blockSizeBytes",
  "logicalSectorBytes",
  "physicalSectorBytes",
  "hyperVGeneration",
  "diskFileFormat",
  "containerId",
] as const;

const getVirtualHardDisk = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualHardDiskName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetVirtualHardDisk({
      subscriptionId,
      resourceGroupName,
      virtualHardDiskName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetVirtualHardDiskResponse,
): VirtualHardDisk["Attributes"] => ({
  virtualHardDiskName: name,
  resourceGroup,
  virtualHardDiskId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  diskSizeGB: value.properties?.diskSizeGB,
  tags: userTags(value.tags),
});

export const VirtualHardDiskProvider = () =>
  Provider.succeed(VirtualHardDisk, {
    stables: ["virtualHardDiskName", "resourceGroup", "virtualHardDiskId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        collectAll(hci.ListVirtualHardDiskAll, { subscriptionId }),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) && group !== undefined && value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.virtualHardDiskName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined && SPEC_KEYS.some((key) => !sameValue(news[key], olds[key])))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.virtualHardDiskName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getVirtualHardDisk(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.virtualHardDiskName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualHardDiskName: name,
      };
      const get = getVirtualHardDisk(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Azure Local virtual hard disk ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the virtual hard disk is missing.
      if (observed === undefined) {
        yield* hci.VirtualHardDisksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            diskSizeGB: news.diskSizeGB,
            dynamic: news.dynamic,
            blockSizeBytes: news.blockSizeBytes,
            logicalSectorBytes: news.logicalSectorBytes,
            physicalSectorBytes: news.physicalSectorBytes,
            hyperVGeneration: news.hyperVGeneration,
            diskFileFormat: news.diskFileFormat,
            containerId: news.containerId,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed virtual hard disk.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateVirtualHardDisk({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteVirtualHardDisk({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualHardDiskName: output.virtualHardDiskName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local virtual hard disk ${output.virtualHardDiskName}`,
        getVirtualHardDisk(subscriptionId, output.resourceGroup, output.virtualHardDiskName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
