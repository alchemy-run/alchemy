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
  NEXUS_SLOW_BUDGET,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";
import type {
  NexusAdministratorConfiguration,
  NexusManagedResourceGroupConfiguration,
} from "./Types.ts";

export interface KubernetesClusterProps {
  /**
   * Resource group the Kubernetes cluster is created in. Changing it replaces the
   * Kubernetes cluster.
   */
  resourceGroup: string;
  /**
   * Name of the Kubernetes cluster. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the Kubernetes cluster.
   */
  name?: string;
  /**
   * Azure location of the Kubernetes cluster; must match the location of the Nexus
   * cluster. Changing it replaces the Kubernetes cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the Kubernetes cluster.
   */
  customLocationId: string;
  /**
   * Kubernetes version, e.g. `1.30.4-1`. Changing it upgrades the cluster in
   * place.
   */
  kubernetesVersion: string;
  /**
   * Control plane nodes. `count` and the admin SSH keys are mutable;
   * changing `vmSkuName` or `availabilityZones` replaces the cluster.
   */
  controlPlaneNodeConfiguration: nc.ControlPlaneNodeConfiguration;
  /**
   * Agent pools created with the cluster. Create-only: changing them
   * replaces the cluster (manage extra pools with `AgentPool`).
   */
  initialAgentPoolConfigurations: nc.InitialAgentPoolConfiguration[];
  /**
   * Cloud services network, CNI network, pod/service CIDRs, and attached
   * networks. Changing it replaces the cluster.
   */
  networkConfiguration: nc.NetworkConfiguration;
  /** Entra ID admin groups for the cluster. Changing it replaces the cluster. */
  aadConfiguration?: nc.AadConfiguration;
  /**
   * Admin user name and SSH keys of the nodes. The SSH keys are mutable;
   * changing the user name replaces the cluster.
   */
  administratorConfiguration?: NexusAdministratorConfiguration;
  /**
   * Name and location of the managed resource group the cluster creates.
   * Changing it replaces the cluster.
   */
  managedResourceGroupConfiguration?: NexusManagedResourceGroupConfiguration;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface KubernetesCluster extends Resource<
  "Azure.NetworkCloud.KubernetesCluster",
  KubernetesClusterProps,
  {
    /** Name of the Kubernetes cluster. */
    kubernetesClusterName: string;
    /** ARM resource ID of the Kubernetes cluster. */
    kubernetesClusterId: string;
    /** Resource group that holds the Kubernetes cluster. */
    resourceGroup: string;
    /** Location of the Kubernetes cluster. */
    location: string;
    /** Custom location the Kubernetes cluster is deployed to. */
    customLocationId: string | undefined;
    /** Requested Kubernetes version. */
    kubernetesVersion: string;
    /** Kubernetes version running on the control plane. */
    controlPlaneKubernetesVersion: string | undefined;
    /** ARM ID of the Arc connected cluster. */
    connectedClusterId: string | undefined;
    /** ARM ID of the Nexus cluster hosting the Kubernetes cluster. */
    clusterId: string | undefined;
    /** ARM IDs of the networks attached to the cluster. */
    attachedNetworkIds: string[];
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus Kubernetes cluster (NAKS) — an Arc-connected
 * Kubernetes cluster whose nodes run as Nexus virtual machines on the
 * on-premises racks. Changing `kubernetesVersion` upgrades in place. Needs a
 * deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-kubernetes-cluster-deployment-cli
 *
 * ### Creating a Kubernetes Cluster
 * **Example:** Three control plane nodes and one agent pool
 * ```typescript
 * const naks = yield* Azure.NetworkCloud.KubernetesCluster("naks", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   kubernetesVersion: "1.30.4-1",
 *   controlPlaneNodeConfiguration: { count: 3, vmSkuName: "NC_G6_28_v1" },
 *   initialAgentPoolConfigurations: [
 *     { name: "pool1", count: 3, mode: "System", vmSkuName: "NC_P10_56_v1" },
 *   ],
 *   networkConfiguration: {
 *     cloudServicesNetworkId: csn.cloudServicesNetworkId,
 *     cniNetworkId: l3.l3NetworkId,
 *   },
 *   administratorConfiguration: {
 *     adminUsername: "azureuser",
 *     sshPublicKeys: [{ keyData: "ssh-ed25519 AAAA..." }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const KubernetesCluster = Resource<KubernetesCluster>(
  "Azure.NetworkCloud.KubernetesCluster",
);

type Observed = nc.GetKubernetesClusterResponse;

const getKubernetesCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetKubernetesCluster({
      subscriptionId,
      resourceGroupName,
      kubernetesClusterName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): KubernetesCluster["Attributes"] => {
  const p = observed.properties;
  return {
    kubernetesClusterName: name,
    kubernetesClusterId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    kubernetesVersion: p.kubernetesVersion,
    controlPlaneKubernetesVersion: p.controlPlaneKubernetesVersion,
    connectedClusterId: p.connectedClusterId,
    clusterId: p.clusterId,
    attachedNetworkIds: [...(p.attachedNetworkIds ?? [])],
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const KubernetesClusterProvider = () =>
  Provider.succeed(KubernetesCluster, {
    stables: [
      "kubernetesClusterName",
      "kubernetesClusterId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListKubernetesClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListKubernetesClusterBySubscription", page),
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
        (news.name !== undefined &&
          !sameArm(news.name, output.kubernetesClusterName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        (olds !== undefined &&
          (!sameArm(
            news.controlPlaneNodeConfiguration.vmSkuName,
            olds.controlPlaneNodeConfiguration.vmSkuName,
          ) ||
            differs(
              news.controlPlaneNodeConfiguration.availabilityZones,
              olds.controlPlaneNodeConfiguration.availabilityZones,
            ) ||
            differs(
              news.initialAgentPoolConfigurations,
              olds.initialAgentPoolConfigurations,
            ) ||
            differs(news.networkConfiguration, olds.networkConfiguration) ||
            differs(news.aadConfiguration, olds.aadConfiguration) ||
            news.administratorConfiguration?.adminUsername !==
              olds.administratorConfiguration?.adminUsername ||
            differs(
              news.managedResourceGroupConfiguration,
              olds.managedResourceGroupConfiguration,
            )))
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
        output?.kubernetesClusterName ??
        olds?.name ??
        (yield* createNexusName(id, 63));
      const observed = yield* getKubernetesCluster(
        subscriptionId,
        resourceGroup,
        name,
      );
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
        news.name ??
        output?.kubernetesClusterName ??
        (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        kubernetesClusterName: name,
      };
      const label = `Nexus Kubernetes cluster ${name}`;
      const get = getKubernetesCluster(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.KubernetesClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            kubernetesVersion: news.kubernetesVersion,
            controlPlaneNodeConfiguration: news.controlPlaneNodeConfiguration,
            initialAgentPoolConfigurations: news.initialAgentPoolConfigurations,
            networkConfiguration: news.networkConfiguration,
            aadConfiguration: news.aadConfiguration,
            administratorConfiguration: news.administratorConfiguration,
            managedResourceGroupConfiguration:
              news.managedResourceGroupConfiguration,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const controlPlane = news.controlPlaneNodeConfiguration;
      const desired: nc.KubernetesClusterPatchProperties = {
        kubernetesVersion: news.kubernetesVersion,
        controlPlaneNodeConfiguration: {
          count: controlPlane.count,
          administratorConfiguration:
            controlPlane.administratorConfiguration?.sshPublicKeys === undefined
              ? undefined
              : {
                  sshPublicKeys:
                    controlPlane.administratorConfiguration.sshPublicKeys,
                },
        },
        administratorConfiguration:
          news.administratorConfiguration?.sshPublicKeys === undefined
            ? undefined
            : { sshPublicKeys: news.administratorConfiguration.sshPublicKeys },
      };
      const delta = propertyDelta(observed.properties, desired);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateKubernetesCluster({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.kubernetesClusterName;
      yield* ignoreNotFound(
        nc.DeleteKubernetesCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          kubernetesClusterName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus Kubernetes cluster ${name}`,
        getKubernetesCluster(subscriptionId, output.resourceGroup, name),
        NEXUS_SLOW_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.CloudServicesNetwork",
        "Azure.NetworkCloud.L2Network",
        "Azure.NetworkCloud.L3Network",
        "Azure.NetworkCloud.TrunkedNetwork",
      ],
    },
  });
