import * as elasticsan from "@distilled.cloud/azure/elasticsan";
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
import { createSanName, isParentOwned, lower } from "./Common.ts";

export type VolumeCreateSource =
  | "None"
  | "VolumeSnapshot"
  | "DiskSnapshot"
  | "Disk"
  | "DiskRestorePoint";

/** Source a volume is created from. */
export interface VolumeCreationData {
  /** Kind of source. */
  createSource: VolumeCreateSource;
  /**
   * ARM resource ID of the source (an Elastic SAN snapshot, a managed disk,
   * a disk snapshot, or a disk restore point).
   */
  sourceId?: string;
}

export interface VolumeProps {
  /** Resource group of the Elastic SAN. Changing it replaces the volume. */
  resourceGroup: string;
  /** Name of the Elastic SAN. Changing it replaces the volume. */
  elasticSan: string;
  /** Name of the volume group. Changing it replaces the volume. */
  volumeGroup: string;
  /**
   * Volume name: 3-63 lowercase letters, digits, hyphens and underscores,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the volume.
   */
  name?: string;
  /**
   * Volume size in GiB. Volumes can grow in place; shrinking replaces the
   * volume (and loses its data).
   */
  sizeGiB: number;
  /**
   * Source to create the volume from. Changing it replaces the volume.
   * @default an empty volume
   */
  creationData?: VolumeCreationData;
}

/** iSCSI connection details of a volume. */
export interface VolumeStorageTarget {
  /** iSCSI qualified name (IQN) of the target. */
  targetIqn: string | undefined;
  /** iSCSI target portal host name. */
  targetPortalHostname: string | undefined;
  /** iSCSI target portal port. */
  targetPortalPort: number | undefined;
  /** Operational status of the target. */
  status: string | undefined;
}

export interface Volume extends Resource<
  "Azure.ElasticSan.Volume",
  VolumeProps,
  {
    /** Name of the volume. */
    volumeName: string;
    /** ARM resource ID of the volume (use it as a snapshot source). */
    volumeResourceId: string;
    /** Unique GUID of the volume. */
    volumeId: string | undefined;
    /** Name of the volume group. */
    volumeGroup: string;
    /** Name of the Elastic SAN. */
    elasticSan: string;
    /** Resource group of the Elastic SAN. */
    resourceGroup: string;
    /** Volume size in GiB. */
    sizeGiB: number;
    /** Kind of source the volume was created from. */
    createSource: string | undefined;
    /** ARM resource ID of the source the volume was created from. */
    sourceId: string | undefined;
    /** iSCSI connection details for clients. */
    storageTarget: VolumeStorageTarget;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A block volume in an Azure Elastic SAN volume group, served over iSCSI.
 * Volumes can be empty or restored from an Elastic SAN snapshot or a
 * managed disk / disk snapshot.
 *
 * Volumes have no tags; Alchemy treats a volume as owned when its parent
 * SAN carries this stack's ownership tags. Deleting a volume also deletes
 * its snapshots and disconnects active iSCSI sessions.
 *
 * @see https://learn.microsoft.com/azure/storage/elastic-san/elastic-san-create
 *
 * ### Creating a Volume
 * **Example:** Empty 100 GiB volume
 * ```typescript
 * const volume = yield* Azure.ElasticSan.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   elasticSan: san.elasticSanName,
 *   volumeGroup: volumes.volumeGroupName,
 *   sizeGiB: 100,
 * });
 * // iSCSI connection info for the client
 * const iqn = volume.storageTarget.targetIqn;
 * ```
 *
 * ### Restoring a Volume
 * **Example:** Volume restored from an Elastic SAN snapshot
 * ```typescript
 * const restored = yield* Azure.ElasticSan.Volume("restored", {
 *   resourceGroup: group.resourceGroupName,
 *   elasticSan: san.elasticSanName,
 *   volumeGroup: volumes.volumeGroupName,
 *   sizeGiB: 100,
 *   creationData: {
 *     createSource: "VolumeSnapshot",
 *     sourceId: snapshot.snapshotId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Volume = Resource<Volume>("Azure.ElasticSan.Volume");

type ObservedVolume = elasticsan.GetVolumeResponse;

const getVolume = (
  subscriptionId: string,
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
  volumeName: string,
) =>
  orUndefinedIfNotFound(
    elasticsan.GetVolume({
      subscriptionId,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
      volumeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  elasticSan: string,
  volumeGroup: string,
  name: string,
  volume: ObservedVolume,
): Volume["Attributes"] => {
  const p = volume.properties;
  return {
    volumeName: name,
    volumeResourceId: volume.id ?? "",
    volumeId: p?.volumeId,
    volumeGroup,
    elasticSan,
    resourceGroup,
    sizeGiB: p?.sizeGiB ?? 0,
    createSource: p?.creationData?.createSource,
    sourceId: p?.creationData?.sourceId,
    storageTarget: {
      targetIqn: p?.storageTarget?.targetIqn,
      targetPortalHostname: p?.storageTarget?.targetPortalHostname,
      targetPortalPort: p?.storageTarget?.targetPortalPort,
      status: p?.storageTarget?.status,
    },
    provisioningState: p?.provisioningState,
  };
};

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: [
      "volumeName",
      "volumeResourceId",
      "volumeId",
      "volumeGroup",
      "elasticSan",
      "resourceGroup",
      "createSource",
      "sourceId",
    ],

    // Volumes live inside a volume group; nuke removes them with the SAN.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const oldSource = olds?.creationData;
      const newSource = news.creationData;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.elasticSan !== output.elasticSan ||
        news.volumeGroup !== output.volumeGroup ||
        (news.name !== undefined && news.name !== output.volumeName) ||
        news.sizeGiB < output.sizeGiB ||
        (newSource?.createSource ?? "None") !==
          (oldSource?.createSource ?? "None") ||
        lower(newSource?.sourceId) !== lower(oldSource?.sourceId)
      ) {
        // An explicit, unchanged name cannot be held by two generations.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && news.name === output.volumeName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const elasticSan = output?.elasticSan ?? olds?.elasticSan;
      const volumeGroup = output?.volumeGroup ?? olds?.volumeGroup;
      if (
        resourceGroup === undefined ||
        elasticSan === undefined ||
        volumeGroup === undefined
      ) {
        return undefined;
      }
      const name =
        output?.volumeName ?? olds?.name ?? (yield* createSanName(id, 63));
      const observed = yield* getVolume(
        subscriptionId,
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
        observed,
      );
      return (yield* isParentOwned(subscriptionId, resourceGroup, elasticSan))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ElasticSan");
      const { resourceGroup, elasticSan, volumeGroup, sizeGiB } = news;
      const name =
        news.name ?? output?.volumeName ?? (yield* createSanName(id, 63));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        elasticSanName: elasticSan,
        volumeGroupName: volumeGroup,
        volumeName: name,
      };
      const get = getVolume(
        subscriptionId,
        resourceGroup,
        elasticSan,
        volumeGroup,
        name,
      );
      const waitReady = waitForProvisioned(
        `elastic san volume ${name}`,
        get,
        (volume) => volume.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* elasticsan.CreateVolume({
          ...where,
          properties: { sizeGiB, creationData: news.creationData },
        });
      }
      observed = yield* waitReady;

      // Sync size (grow only; shrinking is a replacement in diff).
      if ((observed.properties?.sizeGiB ?? 0) < sizeGiB) {
        yield* elasticsan.UpdateVolume({
          ...where,
          properties: { sizeGiB },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, elasticSan, volumeGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elasticsan.DeleteVolume({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          elasticSanName: output.elasticSan,
          volumeGroupName: output.volumeGroup,
          volumeName: output.volumeName,
          xMsDeleteSnapshots: "true",
          xMsForceDelete: "true",
        }),
      );
      yield* waitUntilGone(
        `elastic san volume ${output.volumeName}`,
        getVolume(
          subscriptionId,
          output.resourceGroup,
          output.elasticSan,
          output.volumeGroup,
          output.volumeName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
