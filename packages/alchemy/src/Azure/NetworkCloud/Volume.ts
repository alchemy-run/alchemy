import * as nc from "@distilled.cloud/azure/networkcloud";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNexusName,
  customLocation,
  differs,
  NEXUS_NAMESPACE,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface VolumeProps {
  /**
   * Resource group the volume is created in. Changing it replaces the volume.
   */
  resourceGroup: string;
  /**
   * Name of the volume. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the volume.
   */
  name?: string;
  /**
   * Azure location of the volume; must match the Nexus cluster's location.
   * Changing it replaces the volume.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`
   * of the cluster). Changing it replaces the volume.
   */
  customLocationId: string;
  /** Size of the volume in mebibytes. Changing it replaces the volume. */
  sizeMiB: number;
  /**
   * ARM ID of the storage appliance that hosts the volume. Changing it
   * replaces the volume.
   */
  storageApplianceId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Volume extends Resource<
  "Azure.NetworkCloud.Volume",
  VolumeProps,
  {
    /** Name of the volume. */
    volumeName: string;
    /** ARM resource ID of the volume. */
    volumeId: string;
    /** Resource group that holds the volume. */
    resourceGroup: string;
    /** Location of the volume. */
    location: string;
    /** Custom location the volume is deployed to. */
    customLocationId: string;
    /** Requested size in mebibytes. */
    sizeMiB: number;
    /** Allocated size in mebibytes. */
    allocatedSizeMiB: number | undefined;
    /** Storage appliance the volume was placed on. */
    assignedStorageApplianceId: string | undefined;
    /** ARM IDs of the resources the volume is attached to. */
    attachedTo: string[];
    /** Unique serial number of the volume. */
    serialNumber: string | undefined;
    /** Detailed status, e.g. `Active`. */
    detailedStatus: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus volume — a block storage volume on a Nexus
 * cluster's storage appliance that virtual machines attach as data disks.
 * Needs a deployed Operator Nexus cluster (on-premises hardware).
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-virtual-machine-volume
 *
 * ### Creating a Volume
 * **Example:** 10 GiB volume
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("nexus");
 * const volume = yield* Azure.NetworkCloud.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   sizeMiB: 10240,
 * });
 * ```
 *
 * @resource
 */
export const Volume = Resource<Volume>("Azure.NetworkCloud.Volume");

type Observed = nc.GetVolumeResponse;

const getVolume = (
  subscriptionId: string,
  resourceGroupName: string,
  volumeName: string,
) =>
  orUndefinedIfNotFound(
    nc.GetVolume({ subscriptionId, resourceGroupName, volumeName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): Volume["Attributes"] => {
  const p = observed.properties;
  return {
    volumeName: name,
    volumeId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation.name,
    sizeMiB: p.sizeMiB,
    allocatedSizeMiB: p.allocatedSizeMiB,
    assignedStorageApplianceId: p.assignedStorageApplianceId,
    attachedTo: [...(p.attachedTo ?? [])],
    serialNumber: p.serialNumber,
    detailedStatus: p.detailedStatus,
    provisioningState: p.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: [
      "volumeName",
      "volumeId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListVolumeBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVolumeBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.volumeName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        differs(news.sizeMiB, output.sizeMiB) ||
        (olds !== undefined &&
          !sameArm(news.storageApplianceId, olds.storageApplianceId))
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
        output?.volumeName ?? olds?.name ?? (yield* createNexusName(id));
      const observed = yield* getVolume(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.volumeName ?? (yield* createNexusName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        volumeName: name,
      };
      const label = `Nexus volume ${name}`;
      const get = getVolume(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.VolumesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            sizeMiB: news.sizeMiB,
            storageApplianceId: news.storageApplianceId,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get);

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* nc.UpdateVolume({ ...where, tags });
        observed = yield* waitNexusProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        nc.DeleteVolume({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          volumeName: output.volumeName,
        }),
      );
      yield* waitUntilGone(
        `Nexus volume ${output.volumeName}`,
        getVolume(subscriptionId, output.resourceGroup, output.volumeName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
