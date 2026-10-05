import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { isOwnedChild } from "./Shared.ts";

export interface CassandraDataCenterProps {
  /** Resource group of the cluster. Changing it replaces the data center. */
  resourceGroup: string;
  /**
   * Name of the parent cluster, e.g. `cluster.clusterName`. Changing it
   * replaces the data center.
   */
  cluster: string;
  /**
   * Data center name: letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the data center.
   */
  name?: string;
  /**
   * Region the nodes run in. Must match the region of `delegatedSubnetId`.
   * Changing it replaces the data center.
   * @default the provider's default location
   */
  dataCenterLocation?: string;
  /**
   * ARM ID of the subnet the nodes attach to. It must route to the
   * cluster's management subnet. Changing it replaces the data center.
   */
  delegatedSubnetId: string;
  /**
   * Number of nodes (at least 3). Scaling is applied in place.
   * @default 3
   */
  nodeCount?: number;
  /**
   * VM size of the nodes, e.g. `Standard_D8s_v5` or `Standard_E8s_v5`.
   * Changing it rolls every node in place.
   * @default "Standard_DS14_v2"
   */
  sku?: string;
  /**
   * Managed disk SKU of the data disks, e.g. `P30`. Changing it replaces
   * the data center.
   * @default "P30"
   */
  diskSku?: string;
  /**
   * Number of data disks per node. Changing it replaces the data center.
   * @default 4
   */
  diskCapacity?: number;
  /**
   * Spread nodes across availability zones (where the region supports
   * them). Changing it replaces the data center.
   */
  availabilityZone?: boolean;
  /**
   * Base64-encoded `cassandra.yaml` fragment applied to every node. Only a
   * subset of keys is allowed.
   */
  base64EncodedCassandraYamlFragment?: string;
}

export interface CassandraDataCenter extends Resource<
  "Azure.CosmosDB.CassandraDataCenter",
  CassandraDataCenterProps,
  {
    /** Name of the data center. */
    dataCenterName: string;
    /** Name of the parent cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the data center. */
    dataCenterId: string;
    /** Region the nodes run in (lowercase, no spaces). */
    dataCenterLocation: string;
    /** ARM ID of the node subnet. */
    delegatedSubnetId: string;
    /** Desired node count. */
    nodeCount: number | undefined;
    /** VM size of the nodes. */
    sku: string | undefined;
    /** Managed disk SKU of the data disks. */
    diskSku: string | undefined;
    /** Number of data disks per node. */
    diskCapacity: number | undefined;
    /** Whether nodes are spread across availability zones. */
    availabilityZone: boolean | undefined;
    /** IP addresses of this data center's seed nodes. */
    seedNodes: string[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data center (a set of Cassandra nodes in one region) of an Azure
 * Managed Instance for Apache Cassandra {@link CassandraCluster}. Nodes are
 * billed per VM; a data center needs at least three nodes with 8+ vCPUs
 * each.
 *
 * Data centers cannot be tagged; Alchemy treats one it created (or one
 * under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/managed-instance-apache-cassandra/create-cluster-portal
 *
 * ### Creating a Data Center
 * **Example:** Three-node data center
 * ```typescript
 * const dc = yield* Azure.CosmosDB.CassandraDataCenter("dc1", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   delegatedSubnetId: subnet.subnetId,
 *   dataCenterLocation: "eastus",
 *   sku: "Standard_D8s_v5",
 *   nodeCount: 3,
 * });
 * ```
 *
 * ### Scaling
 * **Example:** Scale out to six nodes
 * ```typescript
 * const dc = yield* Azure.CosmosDB.CassandraDataCenter("dc1", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   delegatedSubnetId: subnet.subnetId,
 *   sku: "Standard_D8s_v5",
 *   nodeCount: 6,
 * });
 * ```
 *
 * @resource
 */
export const CassandraDataCenter = Resource<CassandraDataCenter>(
  "Azure.CosmosDB.CassandraDataCenter",
);

type ObservedDataCenter = cosmos.GetCassandraDataCenterResponse;

const normalizeLocation = (location: string | undefined) =>
  (location ?? "").toLowerCase().replace(/\s+/g, "");

const createDataCenterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 44,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getDataCenter = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  dataCenterName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetCassandraDataCenter({
      subscriptionId,
      resourceGroupName,
      clusterName,
      dataCenterName,
    }),
  );

/** Mutable properties whose observed value differs from the desired one. */
const propertyDelta = (
  news: CassandraDataCenterProps,
  observed: ObservedDataCenter,
): cosmos.DataCenterResourcePropertiesInput => {
  const props = observed.properties ?? {};
  const delta: cosmos.DataCenterResourcePropertiesInput = {};
  const nodeCount = news.nodeCount ?? 3;
  if (props.nodeCount !== nodeCount) delta.nodeCount = nodeCount;
  if (news.sku !== undefined && props.sku !== news.sku) delta.sku = news.sku;
  if (
    news.base64EncodedCassandraYamlFragment !== undefined &&
    props.base64EncodedCassandraYamlFragment !==
      news.base64EncodedCassandraYamlFragment
  ) {
    delta.base64EncodedCassandraYamlFragment =
      news.base64EncodedCassandraYamlFragment;
  }
  return delta;
};

const isEmpty = (value: object) => Object.keys(value).length === 0;

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  dc: ObservedDataCenter,
): CassandraDataCenter["Attributes"] => ({
  dataCenterName: name,
  cluster,
  resourceGroup,
  dataCenterId: dc.id ?? "",
  dataCenterLocation: normalizeLocation(dc.properties?.dataCenterLocation),
  delegatedSubnetId: dc.properties?.delegatedSubnetId ?? "",
  nodeCount: dc.properties?.nodeCount,
  sku: dc.properties?.sku,
  diskSku: dc.properties?.diskSku,
  diskCapacity: dc.properties?.diskCapacity,
  availabilityZone: dc.properties?.availabilityZone,
  seedNodes: (dc.properties?.seedNodes ?? []).flatMap((n) =>
    n.ipAddress ? [n.ipAddress] : [],
  ),
  provisioningState: dc.properties?.provisioningState,
});

// Node provisioning takes 10-20 minutes; the regional operation queue can
// add 20+ minutes on top.
const BUDGET = { interval: "15 seconds", times: 240 } as const;

export const CassandraDataCenterProvider = () =>
  Provider.succeed(CassandraDataCenter, {
    stables: [
      "dataCenterName",
      "cluster",
      "resourceGroup",
      "dataCenterId",
      "dataCenterLocation",
      "delegatedSubnetId",
    ],

    // Data centers disappear with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.cluster !== output.cluster ||
        (news.name !== undefined && news.name !== output.dataCenterName) ||
        (news.dataCenterLocation !== undefined &&
          normalizeLocation(news.dataCenterLocation) !==
            output.dataCenterLocation) ||
        news.delegatedSubnetId.toLowerCase() !==
          output.delegatedSubnetId.toLowerCase() ||
        (news.diskSku !== undefined && news.diskSku !== output.diskSku) ||
        (news.diskCapacity !== undefined &&
          news.diskCapacity !== output.diskCapacity) ||
        (news.availabilityZone !== undefined &&
          news.availabilityZone !== output.availabilityZone)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.dataCenterName ??
        olds?.name ??
        (yield* createDataCenterName(id));
      const observed = yield* getDataCenter(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.dataCenterName ??
        (yield* createDataCenterName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        dataCenterName: name,
      };
      const label = `Cassandra data center ${name}`;
      const get = getDataCenter(subscriptionId, resourceGroup, cluster, name);
      const settled = (dc: ObservedDataCenter) =>
        dc.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. Node provisioning is a long-running operation.
      if (observed === undefined) {
        yield* cosmos.CassandraDataCentersCreateUpdate({
          ...where,
          properties: {
            ...propertyDelta(news, {}),
            dataCenterLocation: normalizeLocation(
              news.dataCenterLocation ?? env.location,
            ),
            delegatedSubnetId: news.delegatedSubnetId,
            diskSku: news.diskSku,
            diskCapacity: news.diskCapacity,
            availabilityZone: news.availabilityZone,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, settled, BUDGET);

      // Sync node count, VM size, and yaml against observed state.
      const delta = propertyDelta(news, observed);
      if (!isEmpty(delta)) {
        // The PATCH operation answers 500 "The method or operation is not
        // implemented", so changes go through a full PUT of the observed
        // properties with the delta applied.
        const current = observed.properties ?? {};
        yield* cosmos.CassandraDataCentersCreateUpdate({
          ...where,
          properties: {
            dataCenterLocation: normalizeLocation(current.dataCenterLocation),
            delegatedSubnetId: current.delegatedSubnetId,
            nodeCount: current.nodeCount,
            sku: current.sku,
            diskSku: current.diskSku,
            diskCapacity: current.diskCapacity,
            availabilityZone: current.availabilityZone,
            base64EncodedCassandraYamlFragment:
              current.base64EncodedCassandraYamlFragment,
            ...delta,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (dc) => (isEmpty(propertyDelta(news, dc)) ? settled(dc) : "Updating"),
          BUDGET,
        );
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos.DeleteCassandraDataCenter({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          dataCenterName: output.dataCenterName,
        }),
      );
      yield* waitUntilGone(
        `Cassandra data center ${output.dataCenterName}`,
        getDataCenter(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.dataCenterName,
        ),
        BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.CassandraCluster",
        "Azure.Network.Subnet",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
