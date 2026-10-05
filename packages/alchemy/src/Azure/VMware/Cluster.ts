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
  CLUSTER_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameName,
} from "./common.ts";

export interface ClusterProps {
  /** Resource group of the private cloud. Changing it replaces the cluster. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the cluster. */
  privateCloud: string;
  /**
   * Name of the cluster. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Host SKU (`av36`, `av36p`, `av52`, `av64`, ...). Changing it replaces
   * the cluster.
   * @default "av36p"
   */
  sku?: string;
  /**
   * Number of hosts (minimum 3). Each host is billed hourly.
   * @default 3
   */
  clusterSize?: number;
  /**
   * Name of the cluster's vSAN datastore. Changing it replaces the cluster.
   */
  vsanDatastoreName?: string;
}

export interface Cluster extends Resource<
  "Azure.VMware.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterResourceId: string;
    /** Numeric vCenter identity of the cluster. */
    clusterId: number | undefined;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Host SKU. */
    sku: string;
    /** Number of hosts. */
    clusterSize: number | undefined;
    /** Host names in the cluster. */
    hosts: string[];
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An additional vSphere cluster in an Azure VMware Solution private cloud.
 *
 * Clusters add at least 3 dedicated hosts (~$8-11 per host-hour each) and
 * take about an hour to provision.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/concepts-private-clouds-clusters
 *
 * ### Adding a Cluster
 * **Example:** Three-host cluster
 * ```typescript
 * const cluster = yield* Azure.VMware.Cluster("workload", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   sku: "av36p",
 *   clusterSize: 3,
 * });
 * ```
 *
 * ### Scaling a Cluster
 * **Example:** Grow the cluster to four hosts
 * ```typescript
 * const cluster = yield* Azure.VMware.Cluster("workload", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   clusterSize: 4,
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.VMware.Cluster");

const createName = (id: string) => createAvsName(id, 32);

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetCluster({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      clusterName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  cluster: vmware.GetClusterResponse,
): Cluster["Attributes"] => ({
  clusterName: name,
  clusterResourceId: cluster.id ?? "",
  clusterId: cluster.properties?.clusterId,
  resourceGroup,
  privateCloud,
  sku: cluster.sku?.name ?? "",
  clusterSize: cluster.properties?.clusterSize,
  hosts: [...(cluster.properties?.hosts ?? [])],
  provisioningState: cluster.properties?.provisioningState,
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterName",
      "clusterResourceId",
      "clusterId",
      "resourceGroup",
      "privateCloud",
    ],

    // Clusters live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        !sameName(news.sku ?? "av36p", output.sku) ||
        news.vsanDatastoreName !== olds?.vsanDatastoreName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const name = output?.clusterName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getCluster(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
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
      const { resourceGroup, privateCloud } = news;
      const name = news.name ?? output?.clusterName ?? (yield* createName(id));
      const clusterSize = news.clusterSize ?? 3;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        clusterName: name,
      };
      const get = getCluster(subscriptionId, resourceGroup, privateCloud, name);
      const wait = () =>
        waitForProvisioned(
          `AVS cluster ${name}`,
          get,
          (cluster) => cluster.properties?.provisioningState,
          CLUSTER_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.ClustersCreateOrUpdate({
          ...where,
          sku: { name: news.sku ?? "av36p" },
          properties: {
            clusterSize,
            vsanDatastoreName: news.vsanDatastoreName,
          },
        });
      }
      observed = yield* wait();

      // Sync the host count against the observed cluster.
      if (observed.properties?.clusterSize !== clusterSize) {
        yield* vmware.UpdateCluster({
          ...where,
          properties: { clusterSize },
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `AVS cluster ${output.clusterName}`,
        getCluster(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.clusterName,
        ),
        CLUSTER_BUDGET,
      );
    }),
  });
