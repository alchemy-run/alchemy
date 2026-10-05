import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CLUSTER_BUDGET,
  createNodeTypeName,
  driftedFields,
  matches,
  sameArm,
} from "./Common.ts";

export type NodeTypeDataDiskType = sf.NodeTypePropertiesInputDataDiskType;
export type NodeTypeSecurityType = sf.SecurityType;

export interface NodeTypePortRange {
  /** First port of the range. */
  startPort: number;
  /** Last port of the range. */
  endPort: number;
}

export interface NodeTypeProps {
  /** Resource group of the cluster. Changing it replaces the node type. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the node type. */
  cluster: string;
  /**
   * Node type name. Without `computerNamePrefix` it is also the VM name
   * prefix, so keep it to 9 characters starting with a letter. If omitted,
   * a unique 9-character name is generated. Changing it replaces the node
   * type.
   */
  name?: string;
  /**
   * Whether the Service Fabric system services run on this node type. A
   * cluster has exactly one primary node type. Changing it replaces the
   * node type.
   */
  isPrimary: boolean;
  /**
   * Number of nodes. A primary node type needs at least 3 (Basic) or 5
   * (Standard) nodes.
   */
  vmInstanceCount: number;
  /**
   * VM size of the nodes.
   * @default "Standard_D2s_v3"
   */
  vmSize?: string;
  /**
   * Marketplace image publisher.
   * @default "MicrosoftWindowsServer"
   */
  vmImagePublisher?: string;
  /**
   * Marketplace image offer.
   * @default "WindowsServer"
   */
  vmImageOffer?: string;
  /**
   * Marketplace image SKU.
   * @default "2022-Datacenter"
   */
  vmImageSku?: string;
  /**
   * Marketplace image version.
   * @default "latest"
   */
  vmImageVersion?: string;
  /**
   * Size of the managed data disk in GB.
   * @default 128
   */
  dataDiskSizeGB?: number;
  /**
   * Storage type of the managed data disk. Changing it replaces the node
   * type.
   * @default "StandardSSD_LRS"
   */
  dataDiskType?: NodeTypeDataDiskType;
  /** Drive letter of the data disk (not `C` or `D`). Changing it replaces the node type. */
  dataDiskLetter?: string;
  /** Placement tags of the nodes, used by placement constraints. */
  placementProperties?: Record<string, string>;
  /** Capacity tags of the nodes, used by the cluster resource manager. */
  capacities?: Record<string, string>;
  /** Port range the cluster assigns to applications. */
  applicationPorts?: NodeTypePortRange;
  /** Ephemeral port range of the nodes. */
  ephemeralPorts?: NodeTypePortRange;
  /** Host only stateless workloads. Changing it replaces the node type. */
  isStateless?: boolean;
  /** Allow the scale set to span multiple placement groups. Changing it replaces the node type. */
  multiplePlacementGroups?: boolean;
  /** Availability zones of the nodes. Changing it replaces the node type. */
  zones?: string[];
  /** Use the temporary disk instead of a managed data disk (stateless only). Changing it replaces the node type. */
  useTempDataDisk?: boolean;
  /** Use an ephemeral OS disk. Changing it replaces the node type. */
  useEphemeralOSDisk?: boolean;
  /** Encrypt all disks at the host. Changing it replaces the node type. */
  enableEncryptionAtHost?: boolean;
  /** Security type (`Standard`, `TrustedLaunch`, `ConfidentialVM`). Changing it replaces the node type. */
  securityType?: NodeTypeSecurityType;
  /** Use Spot VMs. Changing it replaces the node type. */
  isSpotVM?: boolean;
  /** Subnet of the node type (custom VNet clusters). Changing it replaces the node type. */
  subnetId?: string;
  /** Enable accelerated networking on the nodes' NICs. */
  enableAcceleratedNetworking?: boolean;
  /** VM computer-name prefix (up to 9 characters); allows longer node type names. Changing it replaces the node type. */
  computerNamePrefix?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NodeType extends Resource<
  "Azure.ServiceFabric.NodeType",
  NodeTypeProps,
  {
    /** Name of the node type. */
    nodeTypeName: string;
    /** ARM resource ID of the node type. */
    nodeTypeId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Whether this is the primary node type. */
    isPrimary: boolean;
    /** Number of nodes. */
    vmInstanceCount: number;
    /** VM size of the nodes. */
    vmSize: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A node type of an Azure Service Fabric managed cluster — a virtual
 * machine scale set of identical nodes. Every cluster needs exactly one
 * primary node type, which hosts the Service Fabric system services.
 *
 * A primary node type needs at least 3 nodes on a Basic cluster and 5 on a
 * Standard cluster, each with 2+ vCPUs.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/how-to-managed-cluster-modify-node-type
 *
 * ### Creating Node Types
 * **Example:** Primary node type of a Basic cluster
 * ```typescript
 * const primary = yield* Azure.ServiceFabric.NodeType("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.managedClusterName,
 *   isPrimary: true,
 *   vmInstanceCount: 3,
 *   vmSize: "Standard_D2s_v3",
 * });
 * ```
 *
 * **Example:** Secondary stateless node type for front-end services
 * ```typescript
 * const web = yield* Azure.ServiceFabric.NodeType("web", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.managedClusterName,
 *   isPrimary: false,
 *   isStateless: true,
 *   vmInstanceCount: 2,
 *   placementProperties: { role: "web" },
 * });
 * ```
 *
 * @resource
 */
export const NodeType = Resource<NodeType>("Azure.ServiceFabric.NodeType");

type ObservedNodeType = sf.GetNodeTypeResponse | sf.NodeType;

const getNodeType = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  nodeTypeName: string,
) =>
  orUndefinedIfNotFound(
    sf.GetNodeType({
      subscriptionId,
      resourceGroupName,
      clusterName,
      nodeTypeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  nodeType: ObservedNodeType,
): NodeType["Attributes"] => ({
  nodeTypeName: name,
  nodeTypeId: nodeType.id ?? "",
  cluster,
  resourceGroup,
  isPrimary: nodeType.properties?.isPrimary ?? false,
  vmInstanceCount:
    nodeType.sku?.capacity ?? nodeType.properties?.vmInstanceCount ?? 0,
  vmSize: nodeType.properties?.vmSize,
  tags: userTags(nodeType.tags),
});

/** Properties that can change in place (sent with a full PUT). */
const mutableProperties = (news: NodeTypeProps) => ({
  vmInstanceCount: news.vmInstanceCount,
  vmSize: news.vmSize ?? "Standard_D2s_v3",
  vmImagePublisher: news.vmImagePublisher ?? "MicrosoftWindowsServer",
  vmImageOffer: news.vmImageOffer ?? "WindowsServer",
  vmImageSku: news.vmImageSku ?? "2022-Datacenter",
  vmImageVersion: news.vmImageVersion ?? "latest",
  dataDiskSizeGB: news.useTempDataDisk
    ? news.dataDiskSizeGB
    : (news.dataDiskSizeGB ?? 128),
  placementProperties: news.placementProperties,
  capacities: news.capacities,
  applicationPorts: news.applicationPorts,
  ephemeralPorts: news.ephemeralPorts,
  enableAcceleratedNetworking: news.enableAcceleratedNetworking,
});

/** Immutable properties compared in `diff` (against the previous props). */
const immutableProperties = (news: NodeTypeProps) => ({
  isPrimary: news.isPrimary,
  dataDiskType: news.useTempDataDisk
    ? news.dataDiskType
    : (news.dataDiskType ?? "StandardSSD_LRS"),
  dataDiskLetter: news.dataDiskLetter,
  isStateless: news.isStateless ?? false,
  multiplePlacementGroups: news.multiplePlacementGroups ?? false,
  zones: news.zones,
  useTempDataDisk: news.useTempDataDisk ?? false,
  useEphemeralOSDisk: news.useEphemeralOSDisk ?? false,
  enableEncryptionAtHost: news.enableEncryptionAtHost ?? false,
  securityType: news.securityType,
  isSpotVM: news.isSpotVM ?? false,
  subnetId: news.subnetId,
  computerNamePrefix: news.computerNamePrefix,
});

export const NodeTypeProvider = () =>
  Provider.succeed(NodeType, {
    stables: ["nodeTypeName", "nodeTypeId", "cluster", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusters = yield* sf
        .ListManagedClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedClusterBySubscription", page),
          ),
        );
      const found: NodeType["Attributes"][] = [];
      for (const cluster of clusters.value ?? []) {
        const group = resourceGroupOf(cluster.id);
        if (group === undefined || cluster.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          sf.ListNodeTypeByManagedClusters({
            subscriptionId,
            resourceGroupName: group,
            clusterName: cluster.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListNodeTypeByManagedClusters", page);
        }
        for (const nodeType of page?.value ?? []) {
          if (hasAnyAlchemyTag(nodeType.tags) && nodeType.name !== undefined) {
            found.push(toAttrs(group, cluster.name, nodeType.name, nodeType));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.nodeTypeName) ||
        news.isPrimary !== output.isPrimary
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        !(
          matches(immutableProperties(news), immutableProperties(olds)) &&
          matches(immutableProperties(olds), immutableProperties(news))
        )
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
        output?.nodeTypeName ?? olds?.name ?? (yield* createNodeTypeName(id));
      const observed = yield* getNodeType(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.nodeTypeName ?? (yield* createNodeTypeName(id));
      const tags = yield* desiredTags(id, news.tags);
      const mutable = mutableProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        nodeTypeName: name,
      };
      const get = getNodeType(subscriptionId, resourceGroup, cluster, name);
      const label = `Service Fabric node type ${name}`;
      const put = sf.NodeTypesCreateOrUpdate({
        ...where,
        tags,
        properties: { ...immutableProperties(news), ...mutable },
      });
      const observedProps = (nodeType: ObservedNodeType) =>
        ({
          ...nodeType.properties,
          vmInstanceCount:
            nodeType.sku?.capacity ?? nodeType.properties?.vmInstanceCount,
        }) as Record<string, unknown>;

      // Observe.
      let observed = yield* get;

      // Ensure. Creating the scale set and joining the nodes to the
      // cluster takes 10-30 minutes.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (nodeType) => nodeType.properties?.provisioningState,
        CLUSTER_BUDGET,
      );

      // Sync mutable properties (scale, image, ports, placement) with a
      // full PUT; tag-only drift uses a PATCH.
      if (driftedFields(mutable, observedProps(observed)).length > 0) {
        yield* put;
        observed = yield* waitForProvisioned(
          label,
          get,
          (nodeType) =>
            driftedFields(mutable, observedProps(nodeType)).length > 0
              ? "Updating"
              : nodeType.properties?.provisioningState,
          CLUSTER_BUDGET,
        );
      }
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateNodeType({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (nodeType) =>
            tagsDiffer(nodeType.tags, tags)
              ? "Updating"
              : nodeType.properties?.provisioningState,
          CLUSTER_BUDGET,
        );
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A cluster's last primary node type cannot be deleted on its own; it
      // is removed together with the cluster, which is deleted next.
      const deleted = yield* ignoreNotFound(
        sf.DeleteNodeType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          nodeTypeName: output.nodeTypeName,
        }),
      ).pipe(
        Effect.as(true),
        Effect.catchTag("ServiceFabricPrimaryNodeTypeRequired", () =>
          Effect.succeed(false),
        ),
      );
      if (!deleted) return;
      yield* waitUntilGone(
        `Service Fabric node type ${output.nodeTypeName}`,
        getNodeType(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.nodeTypeName,
        ),
        CLUSTER_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ServiceFabric.ManagedCluster",
      ],
    },
  });
