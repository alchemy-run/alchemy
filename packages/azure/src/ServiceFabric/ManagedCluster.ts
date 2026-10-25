import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import { CLUSTER_BUDGET, createClusterName, driftedFields, sameArm } from "./Common.ts";

export type ManagedClusterSkuName = "Basic" | "Standard";
export type ManagedClusterAddOnFeature = sf.ManagedClusterAddOnFeature;
export type ClusterUpgradeMode = "Automatic" | "Manual";
export type ClusterUpgradeCadence = sf.ClusterUpgradeCadence;

export interface ManagedClusterClientCertificate {
  /** Whether the certificate grants admin (read-write) access; non-admin clients are read-only. */
  isAdmin: boolean;
  /**
   * Certificate thumbprint. Set either this or `commonName`.
   * @default not set
   */
  thumbprint?: string;
  /**
   * Certificate common name.
   * @default not set
   */
  commonName?: string;
  /**
   * Issuer thumbprint; only used together with `commonName`.
   * @default not set
   */
  issuerThumbprint?: string;
}

export interface ManagedClusterAzureActiveDirectory {
  /**
   * Microsoft Entra tenant ID.
   * @default not set
   */
  tenantId?: string;
  /**
   * Entra application ID of the cluster (server) app.
   * @default not set
   */
  clusterApplication?: string;
  /**
   * Entra application ID of the client app.
   * @default not set
   */
  clientApplication?: string;
}

export interface ManagedClusterLoadBalancingRule {
  /** Public port of the load balancer (1-65534, unique per load balancer). */
  frontendPort: number;
  /** Port on the nodes (1-65535). */
  backendPort: number;
  /** Transport protocol. */
  protocol: "tcp" | "udp";
  /** Probe port. @default `backendPort` */
  probePort?: number;
  /** Probe protocol. */
  probeProtocol: "tcp" | "http" | "https";
  /**
   * Probe request path (HTTP/HTTPS probes only).
   * @default not set
   */
  probeRequestPath?: string;
  /**
   * Load distribution policy (`Default`, `SourceIP`, `SourceIPProtocol`).
   * @default "Default"
   */
  loadDistribution?: string;
}

export interface ManagedClusterNetworkSecurityRule {
  /** Rule name. */
  name: string;
  /**
   * Rule description.
   * @default not set
   */
  description?: string;
  /** Protocol (`http`, `https`, `tcp`, `udp`, `icmp`, `ah`, `esp`, `any`). */
  protocol: string;
  /**
   * Source address prefixes (CIDRs or service tags).
   * @default not set
   */
  sourceAddressPrefixes?: string[];
  /**
   * Destination address prefixes.
   * @default not set
   */
  destinationAddressPrefixes?: string[];
  /**
   * Source port ranges.
   * @default not set
   */
  sourcePortRanges?: string[];
  /**
   * Destination port ranges.
   * @default not set
   */
  destinationPortRanges?: string[];
  /**
   * Single source address prefix.
   * @default not set
   */
  sourceAddressPrefix?: string;
  /**
   * Single destination address prefix.
   * @default not set
   */
  destinationAddressPrefix?: string;
  /**
   * Single source port range.
   * @default not set
   */
  sourcePortRange?: string;
  /**
   * Single destination port range.
   * @default not set
   */
  destinationPortRange?: string;
  /** `allow` or `deny`. */
  access: "allow" | "deny";
  /** Rule priority (1000-3000). */
  priority: number;
  /** `inbound` or `outbound`. */
  direction: "inbound" | "outbound";
}

export interface ManagedClusterFabricSetting {
  /** Settings section name, e.g. `ClusterManager`. */
  name: string;
  /** Parameters of the section. */
  parameters: { name: string; value: string }[];
}

export interface ManagedClusterProps {
  /**
   * Resource group the cluster is created in. Changing it replaces the cluster.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Cluster name: 4-23 lowercase letters, digits, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the cluster.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Cluster SKU. `Basic` needs a primary node type with at least 3 nodes
   * and has no cluster fee; `Standard` needs at least 5 nodes and supports
   * zone resiliency. Changing it replaces the cluster.
   * @default "Basic"
   */
  sku?: ManagedClusterSkuName;
  /**
   * DNS label of the cluster's public endpoint. Changing it replaces the
   * cluster.
   * @default the cluster name
   */
  dnsName?: string;
  /** Administrator user name of the node VMs. Changing it replaces the cluster. */
  adminUserName: string;
  /**
   * Administrator password of the node VMs. Azure never returns it, so it
   * is sent on create and on every full update but never compared.
   * @default not sent
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * Client certificates allowed to manage the cluster.
   * @default []
   */
  clients?: ManagedClusterClientCertificate[];
  /**
   * Microsoft Entra authentication settings of the cluster.
   * @default no Entra authentication
   */
  azureActiveDirectory?: ManagedClusterAzureActiveDirectory;
  /**
   * Open the RDP port to the node VMs.
   * @default false
   */
  allowRdpAccess?: boolean;
  /**
   * Load balancing rules applied to the cluster's public load balancer.
   * @default []
   */
  loadBalancingRules?: ManagedClusterLoadBalancingRule[];
  /**
   * Custom network security rules applied to the cluster's virtual network.
   * @default []
   */
  networkSecurityRules?: ManagedClusterNetworkSecurityRule[];
  /**
   * Custom Service Fabric settings.
   * @default []
   */
  fabricSettings?: ManagedClusterFabricSetting[];
  /**
   * Service Fabric runtime version; required when `clusterUpgradeMode` is `Manual`.
   * @default Azure's default
   */
  clusterCodeVersion?: string;
  /**
   * How new Service Fabric runtime versions are applied.
   * @default Azure's default (`Automatic`)
   */
  clusterUpgradeMode?: ClusterUpgradeMode;
  /**
   * When automatic runtime upgrades are applied after release (`Wave0`-`Wave2`).
   * @default Azure's default
   */
  clusterUpgradeCadence?: ClusterUpgradeCadence;
  /**
   * Add-on features (`DnsService`, `BackupRestoreService`, `ResourceMonitorService`).
   * @default []
   */
  addonFeatures?: ManagedClusterAddOnFeature[];
  /**
   * Automatically upgrade node OS images that use version `latest`.
   * @default false
   */
  enableAutoOSUpgrade?: boolean;
  /** Port for client connections. @default 19000 */
  clientConnectionPort?: number;
  /** Port for HTTP gateway connections. @default 19080 */
  httpGatewayConnectionPort?: number;
  /**
   * Spread the cluster across availability zones (Standard SKU). Changing it replaces the cluster.
   * @default false
   */
  zonalResiliency?: boolean;
  /**
   * Create IPv6 address space for the default VNet. Changing it replaces the cluster.
   * @default false
   */
  enableIpv6?: boolean;
  /**
   * Subnet the node types are created in instead of the default VNet. Changing it replaces the cluster.
   * @default the default VNet
   */
  subnetId?: string;
  /**
   * Bring your own VNet with subnets set per node type. Changing it replaces the cluster.
   * @default false
   */
  useCustomVnet?: boolean;
  /**
   * Public IPv4 prefix the load balancer allocates its IP from. Changing it replaces the cluster.
   * @default no prefix
   */
  publicIPPrefixId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ManagedCluster extends Resource<
  "Azure.ServiceFabric.ManagedCluster",
  ManagedClusterProps,
  {
    /** Name of the cluster. */
    managedClusterName: string;
    /** ARM resource ID of the cluster. */
    managedClusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Cluster SKU. */
    sku: string;
    /** DNS label of the cluster endpoint. */
    dnsName: string;
    /** Fully qualified domain name of the cluster's public load balancer. */
    fqdn: string | undefined;
    /** IPv4 address of the cluster's public load balancer. */
    ipv4Address: string | undefined;
    /** Service-generated unique ID of the cluster. */
    clusterId: string | undefined;
    /** Cluster state (`WaitingForNodes` until a primary node type exists, then `Ready`). */
    clusterState: string | undefined;
    /** Thumbprints of the cluster certificates. */
    clusterCertificateThumbprints: string[];
    /** Service Fabric runtime version. */
    clusterCodeVersion: string | undefined;
    /** Port for client connections. */
    clientConnectionPort: number | undefined;
    /** Port for HTTP gateway connections. */
    httpGatewayConnectionPort: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Service Fabric managed cluster
 * (`Microsoft.ServiceFabric/managedClusters`): a Service Fabric cluster whose
 * VMs, load balancer, network, and certificates Azure manages for you. Add a
 * primary `Azure.ServiceFabric.NodeType` to give the cluster nodes. See the
 * [Azure docs](https://learn.microsoft.com/azure/service-fabric/overview-managed-cluster).
 *
 * The cluster creates its public load balancer and IP in a managed
 * `SFC_{clusterId}` resource group. It stays in the `WaitingForNodes` state
 * until a primary node type exists.
 *
 * :::caution
 * A `Basic` cluster needs a primary node type with at least 3 nodes. A
 * `Standard` cluster needs at least 5. Set `clusterCodeVersion` when
 * `clusterUpgradeMode` is `Manual`.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `name`, `location`, `sku`, `dnsName`,
 * `adminUserName`, `zonalResiliency`, `enableIpv6`, `useCustomVnet`,
 * `subnetId`, or `publicIPPrefixId` replaces the cluster and every node type
 * and application in it. Alchemy updates every other prop in place.
 * :::
 *
 * ### Creating a Managed Cluster
 * **Example:** Basic cluster managed with a client certificate
 * ```typescript
 * const password = yield* Config.redacted("SF_ADMIN_PASSWORD");
 * const cluster = yield* Azure.ServiceFabric.ManagedCluster("cluster", {
 *   adminUserName: "sfadmin",
 *   adminPassword: password,
 *   clients: [
 *     { isAdmin: true, thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567" },
 *   ],
 * });
 * const primary = yield* Azure.ServiceFabric.NodeType("primary", {
 *   cluster: cluster.managedClusterName,
 *   isPrimary: true,
 *   vmInstanceCount: 3,
 * });
 * ```
 *
 * ### Networking
 * **Example:** Expose an application port through the load balancer
 * ```typescript
 * const password = yield* Config.redacted("SF_ADMIN_PASSWORD");
 * const cluster = yield* Azure.ServiceFabric.ManagedCluster("cluster", {
 *   adminUserName: "sfadmin",
 *   adminPassword: password,
 *   clients: [
 *     { isAdmin: true, thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567" },
 *   ],
 *   loadBalancingRules: [
 *     {
 *       frontendPort: 443,
 *       backendPort: 8443,
 *       protocol: "tcp",
 *       probeProtocol: "tcp",
 *     },
 *   ],
 *   addonFeatures: ["DnsService"],
 * });
 * ```
 *
 * @resource
 */
export const ManagedCluster = GroupedResource<ManagedCluster>("Azure.ServiceFabric.ManagedCluster");

type ObservedCluster = sf.GetManagedClusterResponse | sf.ManagedCluster;

const getCluster = (subscriptionId: string, resourceGroupName: string, clusterName: string) =>
  orUndefinedIfNotFound(sf.GetManagedCluster({ subscriptionId, resourceGroupName, clusterName }));

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): ManagedCluster["Attributes"] => {
  const props = cluster.properties;
  return {
    managedClusterName: name,
    managedClusterId: cluster.id ?? "",
    resourceGroup,
    location: cluster.location,
    sku: cluster.sku?.name ?? "",
    dnsName: props?.dnsName ?? name,
    fqdn: props?.fqdn,
    ipv4Address: props?.ipv4Address,
    clusterId: props?.clusterId,
    clusterState: props?.clusterState,
    clusterCertificateThumbprints: [...(props?.clusterCertificateThumbprints ?? [])],
    clusterCodeVersion: props?.clusterCodeVersion,
    clientConnectionPort: props?.clientConnectionPort,
    httpGatewayConnectionPort: props?.httpGatewayConnectionPort,
    tags: userTags(cluster.tags),
  };
};

/** Properties that can change in place (sent with a full PUT). */
const mutableProperties = (news: ManagedClusterProps) => ({
  clients: news.clients,
  azureActiveDirectory: news.azureActiveDirectory,
  allowRdpAccess: news.allowRdpAccess,
  loadBalancingRules: news.loadBalancingRules,
  networkSecurityRules: news.networkSecurityRules,
  fabricSettings: news.fabricSettings,
  clusterCodeVersion: news.clusterCodeVersion,
  clusterUpgradeMode: news.clusterUpgradeMode,
  clusterUpgradeCadence: news.clusterUpgradeCadence,
  addonFeatures: news.addonFeatures,
  enableAutoOSUpgrade: news.enableAutoOSUpgrade,
  // The RP rejects an omitted port as `0`; send the documented defaults.
  clientConnectionPort: news.clientConnectionPort ?? 19000,
  httpGatewayConnectionPort: news.httpGatewayConnectionPort ?? 19080,
});

export const ManagedClusterProvider = () =>
  Provider.succeed(ManagedCluster, {
    stables: [
      "managedClusterName",
      "managedClusterId",
      "resourceGroup",
      "location",
      "sku",
      "dnsName",
      "clusterId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(sf.ListManagedClusterBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) && group !== undefined && cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.managedClusterName) ||
        (news.location !== undefined && !sameArm(news.location, output.location)) ||
        (news.sku ?? "Basic") !== output.sku ||
        (news.dnsName !== undefined && news.dnsName !== output.dnsName)
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        (news.adminUserName !== olds.adminUserName ||
          (news.zonalResiliency ?? false) !== (olds.zonalResiliency ?? false) ||
          (news.enableIpv6 ?? false) !== (olds.enableIpv6 ?? false) ||
          (news.useCustomVnet ?? false) !== (olds.useCustomVnet ?? false) ||
          !sameArm(news.subnetId, olds.subnetId) ||
          !sameArm(news.publicIPPrefixId, olds.publicIPPrefixId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.managedClusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.managedClusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const mutable = mutableProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const get = getCluster(subscriptionId, resourceGroup, name);
      const label = `Service Fabric managed cluster ${name}`;
      const put = sf.ManagedClustersCreateOrUpdate({
        ...where,
        location,
        tags,
        sku: { name: news.sku ?? "Basic" },
        properties: {
          ...mutable,
          dnsName: news.dnsName ?? name,
          adminUserName: news.adminUserName,
          adminPassword: news.adminPassword,
          zonalResiliency: news.zonalResiliency,
          enableIpv6: news.enableIpv6,
          subnetId: news.subnetId,
          useCustomVnet: news.useCustomVnet,
          publicIPPrefixId: news.publicIPPrefixId,
        },
      });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; the cluster reports
      // `Succeeded` once its load balancer and IP exist (it then waits
      // for a primary node type).
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (cluster) => cluster.properties?.provisioningState,
        CLUSTER_BUDGET,
      );

      // Sync mutable properties against observed state with a full PUT;
      // tag-only drift uses a PATCH.
      const drifted = driftedFields(
        mutable,
        observed.properties as Record<string, unknown> | undefined,
      );
      if (drifted.length > 0) {
        yield* put;
        observed = yield* waitForProvisioned(
          label,
          get,
          (cluster) =>
            driftedFields(mutable, cluster.properties as Record<string, unknown> | undefined)
              .length > 0
              ? "Updating"
              : cluster.properties?.provisioningState,
          CLUSTER_BUDGET,
        );
      }
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateManagedCluster({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (cluster) =>
            tagsDiffer(cluster.tags, tags) ? "Updating" : cluster.properties?.provisioningState,
          CLUSTER_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sf.DeleteManagedCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.managedClusterName,
        }),
      );
      yield* waitUntilGone(
        `Service Fabric managed cluster ${output.managedClusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.managedClusterName),
        CLUSTER_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
