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
  identityBody,
  identityInSync,
  NEXUS_NAMESPACE,
  NEXUS_SLOW_BUDGET,
  propertyDelta,
  sameArm,
  secretsDiffer,
  waitNexusProvisioned,
} from "./Common.ts";
import type {
  NexusIdentity,
  NexusManagedResourceGroupConfiguration,
} from "./Types.ts";

export interface ClusterProps {
  /**
   * Resource group the cluster is created in. Changing it replaces the
   * cluster.
   */
  resourceGroup: string;
  /**
   * Name of the cluster. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster; must match the location of the Nexus
   * cluster manager. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster manager's custom location (`managerCustomLocationId`).
   * Changing it replaces the cluster.
   */
  customLocationId: string;
  /** Single-rack or multi-rack cluster. Changing it replaces the cluster. */
  clusterType: "SingleRack" | "MultiRack";
  /**
   * Nexus cluster version, e.g. `3.10.0`. Changing it runs an in-place
   * version upgrade.
   */
  clusterVersion: string;
  /** ARM ID of the Network Fabric of the racks. Changing it replaces the cluster. */
  networkFabricId: string;
  /** Aggregator (multi-rack) or single rack definition. */
  aggregatorOrSingleRackDefinition: nc.RackDefinitionInput;
  /** Compute rack definitions of a multi-rack cluster. */
  computeRackDefinitions?: nc.RackDefinitionInput[];
  /**
   * ARM ID of the Log Analytics workspace that receives cluster logs.
   * Changing it replaces the cluster.
   */
  analyticsWorkspaceId?: string;
  /** Where cluster analytics are sent. */
  analyticsOutputSettings?: nc.AnalyticsOutputSettings;
  /** Customer-facing name of the cluster's physical location. */
  clusterLocation?: string;
  /** Service principal the cluster uses to call Azure (password may be `Redacted`). */
  clusterServicePrincipal?: nc.ServicePrincipalInformation;
  /** Where long-running command output is stored. */
  commandOutputSettings?: nc.CommandOutputSettings;
  /** Share of compute machines that must deploy for the cluster to succeed. */
  computeDeploymentThreshold?: nc.ValidationThreshold;
  /**
   * Name and location of the managed resource group the cluster creates.
   * Changing it replaces the cluster.
   */
  managedResourceGroupConfiguration?: NexusManagedResourceGroupConfiguration;
  /** Runtime protection (Defender) settings. */
  runtimeProtectionConfiguration?: nc.RuntimeProtectionConfiguration;
  /** Key Vault that archives cluster secrets. */
  secretArchive?: nc.ClusterSecretArchive;
  /** Key Vault settings for secret archiving. */
  secretArchiveSettings?: nc.SecretArchiveSettings;
  /** How version upgrades roll across racks. */
  updateStrategy?: nc.ClusterUpdateStrategy;
  /** Container vulnerability scanning settings. */
  vulnerabilityScanningSettings?: nc.VulnerabilityScanningSettings;
  /**
   * Deployment kind; must match the cluster manager's kind. Changing it
   * replaces the cluster.
   */
  kind?: "Nexus" | "AzureLocal";
  /** Managed identity of the cluster. */
  identity?: NexusIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.NetworkCloud.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Custom location the cluster is deployed to. */
    customLocationId: string | undefined;
    /** Single-rack or multi-rack. */
    clusterType: string;
    /** Current cluster version. */
    clusterVersion: string;
    /** ARM ID of the Network Fabric. */
    networkFabricId: string;
    /**
     * Custom location of the deployed cluster; workload resources (networks,
     * volumes, VMs, Kubernetes clusters) use it as `customLocationId`.
     */
    clusterExtendedLocationId: string | undefined;
    /** ARM ID of the cluster manager that manages the cluster. */
    clusterManagerId: string | undefined;
    /** Versions the cluster can upgrade to. */
    availableUpgradeVersions: string[];
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
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
 * An Azure Operator Nexus cluster — the Azure representation of a set of
 * on-premises Nexus racks (compute, storage, and Network Fabric). Creating
 * the resource registers the hardware; the multi-hour bare-metal bootstrap
 * is started separately with the cluster `deploy` action. Changing
 * `clusterVersion` runs an in-place upgrade. Needs Operator Nexus hardware.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-cluster
 *
 * ### Creating a Cluster
 * **Example:** Single-rack cluster
 * ```typescript
 * const cluster = yield* Azure.NetworkCloud.Cluster("site1", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: manager.managerCustomLocationId,
 *   clusterType: "SingleRack",
 *   clusterVersion: "3.10.0",
 *   networkFabricId: fabric.networkFabricId,
 *   aggregatorOrSingleRackDefinition: {
 *     networkRackId: rackId,
 *     rackSerialNumber: "AA1234",
 *     rackSkuId: rackSkuId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.NetworkCloud.Cluster");

type Observed = nc.GetClusterResponse;

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetCluster({
      subscriptionId,
      resourceGroupName,
      clusterName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): Cluster["Attributes"] => {
  const p = observed.properties;
  return {
    clusterName: name,
    clusterId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    clusterType: p.clusterType,
    clusterVersion: p.clusterVersion,
    networkFabricId: p.networkFabricId,
    clusterExtendedLocationId: p.clusterExtendedLocation?.name,
    clusterManagerId: p.clusterManagerId,
    availableUpgradeVersions: (p.availableUpgradeVersions ?? []).flatMap(
      (upgrade) =>
        upgrade.targetClusterVersion === undefined
          ? []
          : [upgrade.targetClusterVersion],
    ),
    principalId: observed.identity?.principalId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterName",
      "clusterId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListClusterBySubscription", page),
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
        (news.name !== undefined && !sameArm(news.name, output.clusterName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        !sameArm(news.clusterType, output.clusterType) ||
        !sameArm(news.networkFabricId, output.networkFabricId) ||
        (olds !== undefined &&
          (!sameArm(news.analyticsWorkspaceId, olds.analyticsWorkspaceId) ||
            differs(
              news.managedResourceGroupConfiguration,
              olds.managedResourceGroupConfiguration,
            ) ||
            !sameArm(news.kind, olds.kind)))
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
        output?.clusterName ?? olds?.name ?? (yield* createNexusName(id, 63));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `Nexus cluster ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.ClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          identity: identityBody(news.identity),
          kind: news.kind,
          properties: {
            clusterType: news.clusterType,
            clusterVersion: news.clusterVersion,
            networkFabricId: news.networkFabricId,
            aggregatorOrSingleRackDefinition:
              news.aggregatorOrSingleRackDefinition,
            computeRackDefinitions: news.computeRackDefinitions,
            analyticsWorkspaceId: news.analyticsWorkspaceId,
            analyticsOutputSettings: news.analyticsOutputSettings,
            clusterLocation: news.clusterLocation,
            clusterServicePrincipal: news.clusterServicePrincipal,
            commandOutputSettings: news.commandOutputSettings,
            computeDeploymentThreshold: news.computeDeploymentThreshold,
            managedResourceGroupConfiguration:
              news.managedResourceGroupConfiguration,
            runtimeProtectionConfiguration: news.runtimeProtectionConfiguration,
            secretArchive: news.secretArchive,
            secretArchiveSettings: news.secretArchiveSettings,
            updateStrategy: news.updateStrategy,
            vulnerabilityScanningSettings: news.vulnerabilityScanningSettings,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);

      // Version changes go through the updateVersion action, not PATCH.
      if (!sameArm(observed.properties.clusterVersion, news.clusterVersion)) {
        yield* nc.UpdateClusterVersion({
          ...where,
          targetClusterVersion: news.clusterVersion,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      // Sync mutable aspects against observed state; send only the delta.
      // Azure never returns the service principal password, so it is
      // compared against the previous props.
      const principalChanged =
        news.clusterServicePrincipal !== undefined &&
        (olds === undefined ||
          secretsDiffer(
            news.clusterServicePrincipal,
            olds.clusterServicePrincipal,
          ));
      const observedDelta = propertyDelta(observed.properties, {
        aggregatorOrSingleRackDefinition: news.aggregatorOrSingleRackDefinition,
        computeRackDefinitions: news.computeRackDefinitions,
        analyticsOutputSettings: news.analyticsOutputSettings,
        clusterLocation: news.clusterLocation,
        commandOutputSettings: news.commandOutputSettings,
        computeDeploymentThreshold: news.computeDeploymentThreshold,
        runtimeProtectionConfiguration: news.runtimeProtectionConfiguration,
        secretArchive: news.secretArchive,
        secretArchiveSettings: news.secretArchiveSettings,
        updateStrategy: news.updateStrategy,
        vulnerabilityScanningSettings: news.vulnerabilityScanningSettings,
      });
      const delta =
        observedDelta === undefined && !principalChanged
          ? undefined
          : {
              ...observedDelta,
              clusterServicePrincipal: principalChanged
                ? news.clusterServicePrincipal
                : undefined,
            };
      const identityChanged = !identityInSync(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || identityChanged || tagsChanged) {
        yield* nc.UpdateCluster({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
          identity: identityChanged ? identityBody(news.identity) : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.clusterName;
      yield* ignoreNotFound(
        nc.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus cluster ${name}`,
        getCluster(subscriptionId, output.resourceGroup, name),
        NEXUS_SLOW_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.ClusterManager",
      ],
    },
  });
