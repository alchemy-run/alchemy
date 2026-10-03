import * as aks from "@distilled.cloud/azure/hybridaks";
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
  CLUSTER_WAIT,
  HYBRID_AKS_NAMESPACE,
  type HybridAksExtendedLocation,
  matchesDesired,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** Control plane nodes of a provisioned cluster. */
export interface ProvisionedClusterControlPlane {
  /**
   * Number of control plane nodes; must be odd. Mutable.
   * @default 1
   */
  count?: number;
  /** VM size of the control plane nodes, e.g. `Standard_A4_v2`. Mutable. */
  vmSize?: string;
  /**
   * IP address of the Kubernetes API server. Changing it replaces the
   * cluster.
   */
  hostIP?: string;
}

/** Network configuration of a provisioned cluster. */
export interface ProvisionedClusterNetworkProfile {
  /**
   * Network policy used for the Kubernetes network.
   * @default "calico"
   */
  networkPolicy?: "calico";
  /** CIDR range pod IPs are assigned from, e.g. `10.244.0.0/16`. */
  podCidr?: string;
  /**
   * Number of HA Proxy load balancer VMs.
   * @default 0
   */
  loadBalancerCount?: number;
}

/** CSI drivers installed on a provisioned cluster. */
export interface ProvisionedClusterStorageProfile {
  /**
   * Whether the SMB CSI driver is installed.
   * @default true
   */
  smbCsiDriverEnabled?: boolean;
  /**
   * Whether the NFS CSI driver is installed.
   * @default true
   */
  nfsCsiDriverEnabled?: boolean;
}

/** An initial node pool created together with the cluster. */
export type ProvisionedClusterAgentPoolProfile = aks.NamedAgentPoolProfileInput;

/** Cluster-autoscaler settings (applied when node pools autoscale). */
export type ProvisionedClusterAutoScalerProfile =
  aks.ProvisionedClusterPropertiesInputAutoScalerProfile;

export interface ProvisionedClusterProps {
  /**
   * ARM ID of the Arc-enabled Kubernetes cluster
   * (`Microsoft.Kubernetes/connectedClusters`, kind `ProvisionedCluster`)
   * the AKS Arc cluster is provisioned into. The provisioned cluster is the
   * singleton `default` extension resource of that connected cluster.
   * Changing it replaces the cluster.
   */
  connectedClusterId: string;
  /**
   * Arc custom location of the Azure Local cluster the node VMs run on.
   * Changing it replaces the cluster.
   */
  extendedLocation: HybridAksExtendedLocation;
  /**
   * SSH public keys (at most one) installed on the control plane and node
   * VMs. Changing them replaces the cluster.
   */
  sshPublicKeys?: string[];
  /** Control plane nodes. `count` and `vmSize` are mutable. */
  controlPlane?: ProvisionedClusterControlPlane;
  /**
   * Kubernetes version, e.g. `1.29.4`. Changing it upgrades the cluster in
   * place.
   * @default the newest version the custom location supports
   */
  kubernetesVersion?: string;
  /** Network configuration. Changing it replaces the cluster. */
  networkProfile?: ProvisionedClusterNetworkProfile;
  /** CSI drivers installed on the cluster. Mutable. */
  storageProfile?: ProvisionedClusterStorageProfile;
  /**
   * IP address or CIDR allowed to SSH into the cluster VMs. Mutable.
   */
  authorizedIPRanges?: string;
  /**
   * Node pools created together with the cluster. Only applied on
   * creation; manage pools afterwards with
   * `Azure.HybridContainerService.AgentPool`.
   */
  agentPoolProfiles?: ProvisionedClusterAgentPoolProfile[];
  /**
   * ARM IDs (at most one) of the infrastructure network the nodes attach to:
   * an `Azure.AzureStackHCI.LogicalNetwork` or an
   * `Azure.HybridContainerService.VirtualNetwork`. Changing it replaces the
   * cluster.
   */
  vnetSubnetIds?: string[];
  /**
   * Whether Azure Hybrid Benefit is applied. Mutable.
   * @default "False"
   */
  azureHybridBenefit?: "True" | "False" | "NotApplicable";
  /** Cluster-autoscaler settings. Mutable. */
  autoScalerProfile?: ProvisionedClusterAutoScalerProfile;
}

export interface ProvisionedCluster extends Resource<
  "Azure.HybridContainerService.ProvisionedCluster",
  ProvisionedClusterProps,
  {
    /** ARM resource ID of the provisioned cluster instance. */
    provisionedClusterId: string;
    /** ARM ID of the connected cluster the instance extends. */
    connectedClusterId: string;
    /** ARM ID of the Arc custom location hosting the cluster. */
    customLocationId: string | undefined;
    /** Kubernetes version running on the cluster. */
    kubernetesVersion: string | undefined;
    /** IP address of the Kubernetes API server. */
    controlPlaneHostIP: string | undefined;
    /** Provisioning state of the latest operation. */
    provisioningState: string | undefined;
    /** Observed state of the cluster. */
    currentState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AKS cluster on Azure Local (AKS enabled by Azure Arc): the
 * `provisionedClusterInstances/default` extension of an Arc-enabled
 * Kubernetes cluster, whose control plane and node VMs run on an Azure
 * Local (Azure Stack HCI) cluster behind an Arc custom location.
 *
 * Create the `Microsoft.Kubernetes/connectedClusters` resource (kind
 * `ProvisionedCluster`) first and pass its ID. The cluster carries no tags of
 * its own, so one found at the expected scope is only treated as owned when
 * Alchemy created it. Deleting it leaves the connected cluster in place.
 *
 * @see https://learn.microsoft.com/azure/aks/aksarc/aks-create-clusters-cli
 *
 * ### Creating a Cluster
 * **Example:** Cluster on an Azure Local logical network
 * ```typescript
 * const cluster = yield* Azure.HybridContainerService.ProvisionedCluster("aks", {
 *   connectedClusterId,
 *   extendedLocation: { name: customLocationId },
 *   sshPublicKeys: [sshPublicKey],
 *   controlPlane: { count: 1, vmSize: "Standard_A4_v2" },
 *   vnetSubnetIds: [logicalNetwork.logicalNetworkId],
 *   agentPoolProfiles: [{ name: "nodepool1", count: 1, osType: "Linux" }],
 * });
 * ```
 *
 * ### Updating a Cluster
 * **Example:** Upgrade Kubernetes and scale the control plane
 * ```typescript
 * yield* Azure.HybridContainerService.ProvisionedCluster("aks", {
 *   connectedClusterId,
 *   extendedLocation: { name: customLocationId },
 *   sshPublicKeys: [sshPublicKey],
 *   kubernetesVersion: "1.29.4",
 *   controlPlane: { count: 3, vmSize: "Standard_A4_v2" },
 *   vnetSubnetIds: [logicalNetwork.logicalNetworkId],
 *   azureHybridBenefit: "True",
 * });
 * ```
 *
 * @resource
 */
export const ProvisionedCluster = Resource<ProvisionedCluster>(
  "Azure.HybridContainerService.ProvisionedCluster",
);

const getProvisionedCluster = (connectedClusterResourceUri: string) =>
  orUndefinedIfNotFound(
    aks.GetProvisionedClusterInstance({ connectedClusterResourceUri }),
  );

const toAttrs = (
  connectedClusterId: string,
  value: aks.GetProvisionedClusterInstanceResponse,
): ProvisionedCluster["Attributes"] => ({
  provisionedClusterId: value.id ?? "",
  connectedClusterId,
  customLocationId: value.extendedLocation?.name,
  kubernetesVersion: value.properties?.kubernetesVersion,
  controlPlaneHostIP:
    value.properties?.controlPlane?.controlPlaneEndpoint?.hostIP,
  provisioningState: value.properties?.provisioningState,
  currentState: value.properties?.status?.currentState,
});

/** Immutable request properties built from props (diff replaces on change). */
const immutableSpec = (news: ProvisionedClusterProps) => ({
  linuxProfile:
    news.sshPublicKeys === undefined
      ? undefined
      : {
          ssh: {
            publicKeys: news.sshPublicKeys.map((keyData) => ({ keyData })),
          },
        },
  networkProfile:
    news.networkProfile === undefined
      ? undefined
      : {
          networkPolicy: news.networkProfile.networkPolicy,
          podCidr: news.networkProfile.podCidr,
          loadBalancerProfile:
            news.networkProfile.loadBalancerCount === undefined
              ? undefined
              : { count: news.networkProfile.loadBalancerCount },
        },
  cloudProviderProfile:
    news.vnetSubnetIds === undefined
      ? undefined
      : { infraNetworkProfile: { vnetSubnetIds: news.vnetSubnetIds } },
});

/** Mutable request properties built from props (synced in place). */
const mutableSpec = (news: ProvisionedClusterProps) => ({
  controlPlane:
    news.controlPlane === undefined
      ? undefined
      : {
          count: news.controlPlane.count,
          vmSize: news.controlPlane.vmSize,
          controlPlaneEndpoint:
            news.controlPlane.hostIP === undefined
              ? undefined
              : { hostIP: news.controlPlane.hostIP },
        },
  kubernetesVersion: news.kubernetesVersion,
  storageProfile:
    news.storageProfile === undefined
      ? undefined
      : {
          smbCsiDriver:
            news.storageProfile.smbCsiDriverEnabled === undefined
              ? undefined
              : { enabled: news.storageProfile.smbCsiDriverEnabled },
          nfsCsiDriver:
            news.storageProfile.nfsCsiDriverEnabled === undefined
              ? undefined
              : { enabled: news.storageProfile.nfsCsiDriverEnabled },
        },
  clusterVMAccessProfile:
    news.authorizedIPRanges === undefined
      ? undefined
      : { authorizedIPRanges: news.authorizedIPRanges },
  licenseProfile:
    news.azureHybridBenefit === undefined
      ? undefined
      : { azureHybridBenefit: news.azureHybridBenefit },
  autoScalerProfile: news.autoScalerProfile,
});

export const ProvisionedClusterProvider = () =>
  Provider.succeed(ProvisionedCluster, {
    stables: ["provisionedClusterId", "connectedClusterId"],

    // Extension resources vanish with the connected cluster they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.connectedClusterId, output.connectedClusterId) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          (!sameValue(immutableSpec(news), immutableSpec(olds)) ||
            news.controlPlane?.hostIP !== olds.controlPlane?.hostIP))
      ) {
        // The instance is a singleton (`default`) of the connected cluster,
        // so the old one must be gone before the replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const connectedClusterId =
        output?.connectedClusterId ?? olds?.connectedClusterId;
      if (connectedClusterId === undefined) return undefined;
      const observed = yield* getProvisionedCluster(connectedClusterId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(connectedClusterId, observed);
      // No tags or markers: only a cluster we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HYBRID_AKS_NAMESPACE);
      const { connectedClusterId } = news;
      const get = getProvisionedCluster(connectedClusterId);
      const settle = waitForProvisioned(
        `AKS Arc provisioned cluster ${connectedClusterId}`,
        get,
        (value) => value.properties?.provisioningState,
        CLUSTER_WAIT,
      );
      const mutable = mutableSpec(news);

      // Observe.
      let observed = yield* get;

      // Ensure / sync. The API has no PATCH: the PUT carries the whole
      // desired state, so it runs when the cluster is missing or any
      // user-specified mutable field drifted from the observed cluster.
      if (
        observed === undefined ||
        !matchesDesired(mutable, observed.properties)
      ) {
        yield* aks.ProvisionedClusterInstancesCreateOrUpdate({
          connectedClusterResourceUri: connectedClusterId,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            ...immutableSpec(news),
            ...mutable,
            // Initial pools only; afterwards keep the observed pools so the
            // PUT never reshapes pools managed by AgentPool resources.
            agentPoolProfiles:
              observed === undefined
                ? news.agentPoolProfiles
                : observed.properties?.agentPoolProfiles,
          },
        });
      }
      observed = yield* settle;

      return toAttrs(connectedClusterId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        aks.DeleteProvisionedClusterInstance({
          connectedClusterResourceUri: output.connectedClusterId,
        }),
      );
      yield* waitUntilGone(
        `AKS Arc provisioned cluster ${output.connectedClusterId}`,
        getProvisionedCluster(output.connectedClusterId),
        CLUSTER_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
