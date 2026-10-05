import * as vmware from "@distilled.cloud/azure/vmware";
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
  AVS_NAMESPACE,
  CHILD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameName,
} from "./common.ts";

/** An iSCSI LUN backing a datastore. */
export interface DatastoreDiskPoolVolume {
  /** Azure resource ID of the iSCSI target. */
  targetId: string;
  /** Name of the LUN. */
  lunName: string;
  /**
   * Mount the LUN as a datastore or attach it as a raw LUN.
   * @default "MOUNT"
   */
  mountOption?: "MOUNT" | "ATTACH";
}

/** A Pure Storage Cloud volume backing a vVols datastore. */
export interface DatastorePureStorageVolume {
  /** Azure resource ID of the Pure Storage pool. */
  storagePoolId: string;
  /** Size of the volume in GB. */
  sizeGb: number;
}

export interface DatastoreProps {
  /** Resource group of the private cloud. Changing it replaces the datastore. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the datastore. */
  privateCloud: string;
  /** Name of the cluster the datastore is attached to. Changing it replaces the datastore. */
  cluster: string;
  /**
   * Name of the datastore. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the datastore.
   */
  name?: string;
  /**
   * Azure NetApp Files volume ID. Set exactly one backing volume; changing
   * it replaces the datastore.
   */
  netAppVolumeId?: string;
  /** iSCSI (disk pool) volume. Changing it replaces the datastore. */
  diskPoolVolume?: DatastoreDiskPoolVolume;
  /** Elastic SAN volume ID. Changing it replaces the datastore. */
  elasticSanVolumeId?: string;
  /** Pure Storage volume. Changing it replaces the datastore. */
  pureStorageVolume?: DatastorePureStorageVolume;
}

export interface Datastore extends Resource<
  "Azure.VMware.Datastore",
  DatastoreProps,
  {
    /** Name of the datastore. */
    datastoreName: string;
    /** ARM resource ID of the datastore. */
    datastoreId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Name of the cluster. */
    cluster: string;
    /** Operational status (e.g. `Accessible`, `Attached`). */
    status: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A datastore attached to an Azure VMware Solution cluster, backed by an
 * Azure NetApp Files volume, an Elastic SAN volume, an iSCSI LUN, or a
 * Pure Storage volume.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/attach-azure-netapp-files-to-azure-vmware-solution-hosts
 *
 * ### Attaching Storage
 * **Example:** Azure NetApp Files datastore
 * ```typescript
 * const datastore = yield* Azure.VMware.Datastore("anf", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   cluster: "Cluster-1",
 *   netAppVolumeId: volumeId,
 * });
 * ```
 *
 * **Example:** Elastic SAN datastore
 * ```typescript
 * const datastore = yield* Azure.VMware.Datastore("esan", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   cluster: "Cluster-1",
 *   elasticSanVolumeId: elasticSanVolumeId,
 * });
 * ```
 *
 * @resource
 */
export const Datastore = Resource<Datastore>("Azure.VMware.Datastore");

const createName = (id: string) => createAvsName(id, 32);

const getDatastore = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  clusterName: string,
  datastoreName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetDatastore({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      clusterName,
      datastoreName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  cluster: string,
  name: string,
  datastore: vmware.GetDatastoreResponse,
): Datastore["Attributes"] => ({
  datastoreName: name,
  datastoreId: datastore.id ?? "",
  resourceGroup,
  privateCloud,
  cluster,
  status: datastore.properties?.status,
  provisioningState: datastore.properties?.provisioningState,
});

const backing = (props: DatastoreProps) =>
  JSON.stringify({
    netApp: props.netAppVolumeId?.toLowerCase(),
    diskPool: props.diskPoolVolume,
    elasticSan: props.elasticSanVolumeId?.toLowerCase(),
    pure: props.pureStorageVolume,
  });

export const DatastoreProvider = () =>
  Provider.succeed(Datastore, {
    stables: [
      "datastoreName",
      "datastoreId",
      "resourceGroup",
      "privateCloud",
      "cluster",
    ],

    // Datastores live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        !sameName(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.datastoreName) ||
        (olds !== undefined && backing(news) !== backing(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      const cluster = output?.cluster ?? olds?.cluster;
      if (
        resourceGroup === undefined ||
        privateCloud === undefined ||
        cluster === undefined
      ) {
        return undefined;
      }
      const name =
        output?.datastoreName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getDatastore(
        subscriptionId,
        resourceGroup,
        privateCloud,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        privateCloud,
        cluster,
        name,
        observed,
      );
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud, cluster } = news;
      const name =
        news.name ?? output?.datastoreName ?? (yield* createName(id));
      const get = getDatastore(
        subscriptionId,
        resourceGroup,
        privateCloud,
        cluster,
        name,
      );

      // Observe; ensure. Every property is immutable (replace on change).
      const observed = yield* get;
      if (observed === undefined) {
        yield* vmware.DatastoresCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateCloudName: privateCloud,
          clusterName: cluster,
          datastoreName: name,
          properties: {
            netAppVolume: news.netAppVolumeId
              ? { id: news.netAppVolumeId }
              : undefined,
            diskPoolVolume: news.diskPoolVolume,
            elasticSanVolume: news.elasticSanVolumeId
              ? { targetId: news.elasticSanVolumeId }
              : undefined,
            pureStorageVolume: news.pureStorageVolume,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `AVS datastore ${name}`,
        get,
        (datastore) => datastore.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, privateCloud, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteDatastore({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          clusterName: output.cluster,
          datastoreName: output.datastoreName,
        }),
      );
      yield* waitUntilGone(
        `AVS datastore ${output.datastoreName}`,
        getDatastore(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.cluster,
          output.datastoreName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
