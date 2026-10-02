import * as cs from "@distilled.cloud/azure/containerservice";
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
  createChildName,
  deepMerge,
  getCluster,
  sameName,
  subsetMatches,
  whileClusterBusy,
} from "./Common.ts";

export type ManagedClusterSkuTier = "Free" | "Standard" | "Premium";
export type ManagedClusterUpgradeChannel = cs.UpgradeChannel;
export type ManagedClusterNodeOsUpgradeChannel = cs.NodeOSUpgradeChannel;

export interface ManagedClusterDefaultNodePool {
  /**
   * Name of the system node pool: 1-12 lowercase letters and digits,
   * starting with a letter. Changing it replaces the cluster.
   * @default "system"
   */
  name?: string;
  /**
   * VM size of the nodes (at least 2 vCPUs and 4 GiB memory). Changing it
   * replaces the cluster. Allowed sizes vary by region and subscription.
   * @default chosen by AKS for the region
   */
  vmSize?: string;
  /**
   * Number of nodes. Ignored while `enableAutoScaling` is `true`.
   * @default 1
   */
  count?: number;
  /** Let the cluster autoscaler scale the pool between `minCount` and `maxCount`. */
  enableAutoScaling?: boolean;
  /** Minimum node count when autoscaling. */
  minCount?: number;
  /** Maximum node count when autoscaling. */
  maxCount?: number;
  /** OS disk size in GiB. Changing it replaces the cluster. */
  osDiskSizeGB?: number;
  /** Node OS SKU (e.g. `Ubuntu`, `AzureLinux`). Changing it replaces the cluster. */
  osSKU?: cs.OSSKU;
  /** Maximum pods per node. Changing it replaces the cluster. */
  maxPods?: number;
  /** Availability zones of the nodes. Changing them replaces the cluster. */
  availabilityZones?: string[];
  /** Subnet the nodes join (Azure CNI). Changing it replaces the cluster. */
  vnetSubnetId?: string;
}

export interface ManagedClusterAadProfile {
  /** Use Azure RBAC for Kubernetes authorization. */
  enableAzureRbac?: boolean;
  /** Entra ID group object IDs that get cluster-admin. */
  adminGroupObjectIds?: string[];
  /**
   * Tenant of the Entra ID integration.
   * @default the subscription's tenant
   */
  tenantId?: string;
}

export interface ManagedClusterAddon {
  /** Whether the add-on is enabled. */
  enabled: boolean;
  /** Add-on specific configuration (e.g. `logAnalyticsWorkspaceResourceID`). */
  config?: Record<string, string>;
}

export interface ManagedClusterProps {
  /** Resource group of the cluster. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 1-63 letters, digits, `-` and `_`. If omitted, a unique
   * name (at most 40 characters) is generated from the app, stage, and
   * logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * DNS prefix of the API server FQDN. Changing it replaces the cluster.
   * @default derived from the cluster name
   */
  dnsPrefix?: string;
  /**
   * Kubernetes version, `major.minor` or `major.minor.patch`. Raising it
   * upgrades the cluster in place; Kubernetes cannot be downgraded.
   * @default the AKS default version for the region
   */
  kubernetesVersion?: string;
  /**
   * Control-plane pricing tier.
   * @default "Free"
   */
  skuTier?: ManagedClusterSkuTier;
  /**
   * The system node pool created with the cluster. Add more pools with
   * `Azure.ContainerService.AgentPool`.
   */
  defaultNodePool?: ManagedClusterDefaultNodePool;
  /**
   * Resource ID of a user-assigned managed identity for the control plane.
   * When omitted the cluster uses a system-assigned identity.
   */
  userAssignedIdentityId?: string;
  /**
   * Name of the resource group AKS creates for nodes and load balancers.
   * Changing it replaces the cluster.
   * @default `MC_{resourceGroup}_{name}_{location}` (`MC_{name}_{location}` when that exceeds 80 characters)
   */
  nodeResourceGroup?: string;
  /**
   * Network plugin. Changing it replaces the cluster.
   * @default "azure" with `networkPluginMode: "overlay"`
   */
  networkPlugin?: cs.NetworkPlugin;
  /**
   * Network plugin mode. Changing it replaces the cluster.
   * @default "overlay" when `networkPlugin` is `azure`
   */
  networkPluginMode?: cs.NetworkPluginMode;
  /** Network policy engine. Changing it replaces the cluster. */
  networkPolicy?: cs.NetworkPolicy;
  /** Kubernetes service CIDR. Changing it replaces the cluster. */
  serviceCidr?: string;
  /** Kubernetes DNS service IP (inside `serviceCidr`). Changing it replaces the cluster. */
  dnsServiceIp?: string;
  /** Pod CIDR (overlay / kubenet). Changing it replaces the cluster. */
  podCidr?: string;
  /** Outbound routing method. Changing it replaces the cluster. */
  outboundType?: cs.ContainerServiceNetworkProfileInputOutboundType;
  /**
   * Enable Kubernetes RBAC. Changing it replaces the cluster.
   * @default true
   */
  enableRbac?: boolean;
  /**
   * AKS-managed Entra ID integration. Once enabled it cannot be removed.
   */
  aad?: ManagedClusterAadProfile;
  /**
   * Disable local (certificate) accounts. Requires `aad`.
   * @default false
   */
  disableLocalAccounts?: boolean;
  /**
   * Enable the OIDC issuer (required for workload identity). Cannot be
   * disabled once enabled.
   * @default false
   */
  oidcIssuerEnabled?: boolean;
  /**
   * Enable Microsoft Entra Workload ID. Requires `oidcIssuerEnabled`.
   * @default false
   */
  workloadIdentityEnabled?: boolean;
  /** IP ranges (CIDR) allowed to reach the public API server. */
  authorizedIpRanges?: string[];
  /** Kubernetes auto-upgrade channel. */
  autoUpgradeChannel?: ManagedClusterUpgradeChannel;
  /** Node OS image auto-upgrade channel. */
  nodeOsUpgradeChannel?: ManagedClusterNodeOsUpgradeChannel;
  /**
   * Add-ons keyed by name (e.g. `azurepolicy`, `omsagent`,
   * `azureKeyvaultSecretsProvider`).
   */
  addonProfiles?: Record<string, ManagedClusterAddon>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedClusterKubeletIdentity {
  /** Client ID of the kubelet identity (use for image pulls). */
  clientId: string | undefined;
  /** Object (principal) ID of the kubelet identity; grant it `AcrPull`. */
  objectId: string | undefined;
  /** ARM resource ID of the kubelet identity. */
  resourceId: string | undefined;
}

export interface ManagedCluster extends Resource<
  "Azure.ContainerService.ManagedCluster",
  ManagedClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterId: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** DNS prefix of the API server. */
    dnsPrefix: string | undefined;
    /** Public FQDN of the API server. */
    fqdn: string | undefined;
    /** Private FQDN of the API server (private clusters). */
    privateFqdn: string | undefined;
    /** FQDN the Azure portal uses to reach the API server. */
    azurePortalFqdn: string | undefined;
    /** Kubernetes version the control plane runs. */
    kubernetesVersion: string | undefined;
    /** Resource group that holds the nodes. */
    nodeResourceGroup: string | undefined;
    /** Control-plane pricing tier. */
    skuTier: string | undefined;
    /** Principal ID of the system-assigned identity. */
    principalId: string | undefined;
    /** Tenant of the cluster identity. */
    tenantId: string | undefined;
    /** Identity the kubelet uses (e.g. to pull from ACR). */
    kubeletIdentity: ManagedClusterKubeletIdentity;
    /** OIDC issuer URL (when `oidcIssuerEnabled`). */
    oidcIssuerUrl: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Kubernetes Service (AKS) managed cluster with a system node pool.
 *
 * Creating a cluster takes about 5-10 minutes. Nodes are billed as virtual
 * machines; the `Free` control-plane tier costs nothing.
 *
 * @see https://learn.microsoft.com/azure/aks/what-is-aks
 *
 * ### Creating a Cluster
 * **Example:** Minimal cluster
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const cluster = yield* Azure.ContainerService.ManagedCluster("aks", {
 *   resourceGroup: group.resourceGroupName,
 *   defaultNodePool: { vmSize: "Standard_D2s_v7", count: 1 },
 * });
 * ```
 *
 * **Example:** Autoscaling system pool on the Standard tier
 * ```typescript
 * const cluster = yield* Azure.ContainerService.ManagedCluster("aks", {
 *   resourceGroup: group.resourceGroupName,
 *   skuTier: "Standard",
 *   defaultNodePool: { enableAutoScaling: true, minCount: 1, maxCount: 3 },
 * });
 * ```
 *
 * ### Identity and Security
 * **Example:** Workload identity with Entra ID and Azure RBAC
 * ```typescript
 * const cluster = yield* Azure.ContainerService.ManagedCluster("aks", {
 *   resourceGroup: group.resourceGroupName,
 *   oidcIssuerEnabled: true,
 *   workloadIdentityEnabled: true,
 *   aad: { enableAzureRbac: true },
 * });
 * ```
 *
 * **Example:** Let the kubelet pull from a container registry
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("acr-pull", {
 *   scope: registry.registryId,
 *   roleDefinitionId: "7f951dda-4ed3-4680-a7ca-43fe172d538d", // AcrPull
 *   principalId: cluster.kubeletIdentity.objectId,
 * });
 * ```
 *
 * @resource
 */
export const ManagedCluster = Resource<ManagedCluster>(
  "Azure.ContainerService.ManagedCluster",
);

type ObservedCluster = cs.GetManagedClusterResponse;

const createClusterName = (id: string) => createChildName(id, 40);

/**
 * AKS defaults the node resource group to `MC_{rg}_{name}_{location}` and
 * rejects it above 80 characters; fall back to `MC_{name}_{location}`
 * (the cluster name is already unique) for long resource group names.
 */
const defaultNodeResourceGroup = (
  resourceGroup: string,
  name: string,
  location: string,
) =>
  `MC_${resourceGroup}_${name}_${location}`.length <= 80
    ? undefined
    : `MC_${name}_${location}`.slice(0, 80);

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): ManagedCluster["Attributes"] => {
  const props = cluster.properties ?? {};
  const kubelet = props.identityProfile?.["kubeletidentity"];
  return {
    clusterName: name,
    clusterId: cluster.id ?? "",
    resourceGroup,
    location: cluster.location,
    dnsPrefix: props.dnsPrefix,
    fqdn: props.fqdn,
    privateFqdn: props.privateFQDN,
    azurePortalFqdn: props.azurePortalFQDN,
    kubernetesVersion:
      props.currentKubernetesVersion ?? props.kubernetesVersion,
    nodeResourceGroup: props.nodeResourceGroup,
    skuTier: cluster.sku?.tier,
    principalId: cluster.identity?.principalId,
    tenantId: cluster.identity?.tenantId,
    kubeletIdentity: {
      clientId: kubelet?.clientId,
      objectId: kubelet?.objectId,
      resourceId: kubelet?.resourceId,
    },
    oidcIssuerUrl: props.oidcIssuerProfile?.issuerURL,
    tags: userTags(cluster.tags),
  };
};

const identityOf = (
  news: ManagedClusterProps,
): cs.ManagedClusterIdentityInput =>
  news.userAssignedIdentityId
    ? {
        type: "UserAssigned",
        userAssignedIdentities: { [news.userAssignedIdentityId]: {} },
      }
    : { type: "SystemAssigned" };

const poolName = (news: ManagedClusterProps) =>
  news.defaultNodePool?.name ?? "system";

/** Mutable cluster aspects, as an ARM properties subset. */
const mutableProperties = (news: ManagedClusterProps) => ({
  kubernetesVersion: news.kubernetesVersion,
  aadProfile: news.aad
    ? {
        managed: true,
        enableAzureRBAC: news.aad.enableAzureRbac,
        adminGroupObjectIDs: news.aad.adminGroupObjectIds,
        tenantID: news.aad.tenantId,
      }
    : undefined,
  disableLocalAccounts: news.disableLocalAccounts,
  oidcIssuerProfile:
    news.oidcIssuerEnabled !== undefined
      ? { enabled: news.oidcIssuerEnabled }
      : undefined,
  securityProfile:
    news.workloadIdentityEnabled !== undefined
      ? { workloadIdentity: { enabled: news.workloadIdentityEnabled } }
      : undefined,
  apiServerAccessProfile:
    news.authorizedIpRanges !== undefined
      ? { authorizedIPRanges: news.authorizedIpRanges }
      : undefined,
  autoUpgradeProfile:
    news.autoUpgradeChannel !== undefined ||
    news.nodeOsUpgradeChannel !== undefined
      ? {
          upgradeChannel: news.autoUpgradeChannel,
          nodeOSUpgradeChannel: news.nodeOsUpgradeChannel,
        }
      : undefined,
  addonProfiles: news.addonProfiles,
});

/** Mutable fields of the system pool. */
const mutablePool = (news: ManagedClusterProps) => {
  const pool = news.defaultNodePool ?? {};
  return pool.enableAutoScaling
    ? {
        enableAutoScaling: true,
        minCount: pool.minCount,
        maxCount: pool.maxCount,
      }
    : { enableAutoScaling: false, count: pool.count ?? 1 };
};

const removeUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

const createBody = (
  news: ManagedClusterProps,
  name: string,
  location: string,
  tags: Record<string, string>,
): Omit<
  cs.ManagedClustersCreateOrUpdateRequest,
  "subscriptionId" | "resourceGroupName" | "resourceName"
> => {
  const pool = news.defaultNodePool ?? {};
  const plugin = news.networkPlugin ?? "azure";
  return {
    location,
    tags,
    sku: { name: "Base", tier: news.skuTier ?? "Free" },
    identity: identityOf(news),
    properties: removeUndefined({
      ...removeUndefined(mutableProperties(news)),
      dnsPrefix: news.dnsPrefix ?? name.replace(/_/g, "-").slice(0, 54),
      enableRBAC: news.enableRbac ?? true,
      nodeResourceGroup:
        news.nodeResourceGroup ??
        defaultNodeResourceGroup(news.resourceGroup, name, location),
      networkProfile: removeUndefined({
        networkPlugin: plugin,
        networkPluginMode:
          news.networkPluginMode ??
          (plugin === "azure" && news.networkPlugin === undefined
            ? ("overlay" as const)
            : undefined),
        networkPolicy: news.networkPolicy,
        serviceCidr: news.serviceCidr,
        dnsServiceIP: news.dnsServiceIp,
        podCidr: news.podCidr,
        outboundType: news.outboundType,
      }),
      agentPoolProfiles: [
        removeUndefined({
          name: poolName(news),
          mode: "System" as const,
          type: "VirtualMachineScaleSets" as const,
          vmSize: pool.vmSize,
          osType: "Linux" as const,
          osDiskSizeGB: pool.osDiskSizeGB,
          osSKU: pool.osSKU,
          maxPods: pool.maxPods,
          availabilityZones: pool.availabilityZones,
          vnetSubnetID: pool.vnetSubnetId,
          ...mutablePool(news),
        }),
      ],
    }),
  };
};

const stateOf = (cluster: ObservedCluster) =>
  cluster.properties?.provisioningState;

const isPending = (state: string | undefined) =>
  state !== undefined &&
  state !== "Succeeded" &&
  state !== "Failed" &&
  state !== "Canceled";

const lower = (value: string | undefined) => value?.toLowerCase();

export const ManagedClusterProvider = () =>
  Provider.succeed(ManagedCluster, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cs
        .ListManagedClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedClusters", page),
          ),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const oldPool = olds?.defaultNodePool ?? {};
      const newPool = news.defaultNodePool ?? {};
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.dnsPrefix !== undefined &&
          output.dnsPrefix !== undefined &&
          news.dnsPrefix !== output.dnsPrefix) ||
        (news.nodeResourceGroup !== undefined &&
          output.nodeResourceGroup !== undefined &&
          !sameName(news.nodeResourceGroup, output.nodeResourceGroup))
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const immutable = [
          [olds.networkPlugin, news.networkPlugin],
          [olds.networkPluginMode, news.networkPluginMode],
          [olds.networkPolicy, news.networkPolicy],
          [olds.serviceCidr, news.serviceCidr],
          [olds.dnsServiceIp, news.dnsServiceIp],
          [olds.podCidr, news.podCidr],
          [olds.outboundType, news.outboundType],
          [olds.enableRbac ?? true, news.enableRbac ?? true],
          [oldPool.name ?? "system", newPool.name ?? "system"],
          [oldPool.vmSize, newPool.vmSize],
          [oldPool.osDiskSizeGB, newPool.osDiskSizeGB],
          [oldPool.osSKU, newPool.osSKU],
          [oldPool.maxPods, newPool.maxPods],
          [oldPool.vnetSubnetId, newPool.vnetSubnetId],
          [
            (oldPool.availabilityZones ?? []).join(","),
            (newPool.availabilityZones ?? []).join(","),
          ],
        ] as const;
        if (immutable.some(([a, b]) => lower(String(a)) !== lower(String(b)))) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const label = `managed cluster ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);
      // Cluster create/update runs 5-10 minutes.
      const waitReady = waitForProvisioned(label, get, stateOf, {
        interval: "15 seconds",
        times: 60,
      });

      // Observe. A cluster mid-operation must settle before it is changed.
      let observed = yield* get;
      if (observed !== undefined && isPending(stateOf(observed))) {
        observed = yield* waitReady;
      }

      // Ensure.
      if (observed === undefined) {
        yield* cs
          .ManagedClustersCreateOrUpdate({
            ...where,
            ...createBody(news, name, location, tags),
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      // Sync mutable aspects against the observed cluster. A cluster PUT
      // replaces the whole model, so the body is the observed cluster with
      // the desired deltas applied (the same GET-modify-PUT `az aks update`
      // performs).
      const props = observed.properties ?? {};
      const desired = removeUndefined(mutableProperties(news));
      const versionDrift =
        news.kubernetesVersion !== undefined &&
        !(
          props.currentKubernetesVersion ??
          props.kubernetesVersion ??
          ""
        ).startsWith(news.kubernetesVersion);
      const { kubernetesVersion: _version, ...rest } = desired;
      const propsDrift = !subsetMatches(rest, props);
      const tierDrift =
        (observed.sku?.tier ?? "Free") !== (news.skuTier ?? "Free");
      const desiredIdentity = identityOf(news);
      const identityDrift =
        observed.identity?.type !== desiredIdentity.type ||
        (news.userAssignedIdentityId !== undefined &&
          !Object.keys(observed.identity?.userAssignedIdentities ?? {}).some(
            (key) => sameName(key, news.userAssignedIdentityId),
          ));
      const pools = props.agentPoolProfiles ?? [];
      const systemPool = pools.find((pool) =>
        sameName(pool.name, poolName(news)),
      );
      const poolDrift =
        systemPool !== undefined &&
        !subsetMatches(mutablePool(news), systemPool);

      if (
        versionDrift ||
        propsDrift ||
        tierDrift ||
        identityDrift ||
        poolDrift
      ) {
        const agentPoolProfiles = pools.map((pool) =>
          deepMerge<cs.ManagedClusterAgentPoolProfileInput>(
            pool,
            sameName(pool.name, poolName(news))
              ? {
                  ...mutablePool(news),
                  orchestratorVersion: versionDrift
                    ? news.kubernetesVersion
                    : undefined,
                }
              : {},
          ),
        );
        yield* cs
          .ManagedClustersCreateOrUpdate({
            ...where,
            location: observed.location,
            tags,
            sku: { ...observed.sku, tier: news.skuTier ?? "Free" },
            identity: desiredIdentity,
            kind: observed.kind,
            extendedLocation: observed.extendedLocation,
            properties: {
              ...deepMerge<cs.ManagedClusterPropertiesInput>(props, desired),
              kubernetesVersion: versionDrift
                ? news.kubernetesVersion
                : props.kubernetesVersion,
              agentPoolProfiles,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* cs
          .UpdateManagedClusterTags({ ...where, tags })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteManagedCluster({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.clusterName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      // Deleting a cluster (and its node resource group) takes 3-10 minutes.
      yield* waitUntilGone(
        `managed cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "15 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
