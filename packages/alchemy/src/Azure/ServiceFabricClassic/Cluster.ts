import * as servicefabric from "@distilled.cloud/azure/servicefabric";
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
  createClusterName,
  delta,
  getCluster,
  lower,
  matches,
} from "./Common.ts";

export interface ClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 4-23 lowercase letters, digits, and hyphens, starting with
   * a letter. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * HTTP management endpoint of the cluster. Changing it replaces the
   * cluster.
   * @default `http(s)://<name>.<location>.cloudapp.azure.com:<httpGatewayEndpointPort of the primary node type>` (`https` when a certificate is set)
   */
  managementEndpoint?: string;
  /**
   * Node types of the cluster. Exactly one must be `isPrimary`. Each node
   * type is backed by a separately deployed virtual machine scale set
   * carrying the `ServiceFabricNode` extension; until those VMs report in,
   * the cluster stays in `WaitingForNodes`. Non-primary node types and
   * instance counts can change in place (a cluster upgrade).
   */
  nodeTypes: servicefabric.NodeTypeDescription[];
  /**
   * Replica set size of the system services: `None` (1, test clusters
   * only), `Bronze` (3), `Silver` (5), `Gold` (7), `Platinum` (9).
   * Changeable in place (a cluster upgrade).
   */
  reliabilityLevel?: servicefabric.ReliabilityLevel;
  /**
   * `Automatic` upgrades follow new runtime releases; `Manual` pins
   * `clusterCodeVersion`.
   * @default "Automatic"
   */
  upgradeMode?: servicefabric.UpgradeMode;
  /** Service Fabric runtime version. Settable only when `upgradeMode` is `Manual`. */
  clusterCodeVersion?: string;
  /**
   * Operating system of the scale sets (`Windows` or `Linux`). Changing it
   * replaces the cluster.
   * @default "Windows"
   */
  vmImage?: string;
  /** Cluster certificate (node-to-node security and the management endpoint). */
  certificate?: servicefabric.CertificateDescription;
  /** Cluster certificates referenced by common name. */
  certificateCommonNames?: servicefabric.ServerCertificateCommonNames;
  /** Client certificates (by thumbprint) allowed to manage the cluster. */
  clientCertificateThumbprints?: servicefabric.ClientCertificateThumbprint[];
  /** Client certificates (by common name) allowed to manage the cluster. */
  clientCertificateCommonNames?: servicefabric.ClientCertificateCommonName[];
  /** Server certificate of the reverse proxy. */
  reverseProxyCertificate?: servicefabric.CertificateDescription;
  /** Microsoft Entra ID authentication for the cluster. */
  azureActiveDirectory?: servicefabric.AzureActiveDirectory;
  /** Storage account receiving Service Fabric diagnostic logs. */
  diagnosticsStorageAccountConfig?: servicefabric.DiagnosticsStorageAccountConfig;
  /** Add-on system services (`RepairManager`, `DnsService`, `BackupRestoreService`, `ResourceMonitorService`). */
  addOnFeatures?: servicefabric.AddOnFeatures[];
  /** Custom fabric settings sections. */
  fabricSettings?: servicefabric.SettingsSectionDescription[];
  /** Enable the event store service. */
  eventStoreServiceEnabled?: boolean;
  /** Policy applied to cluster upgrades. */
  upgradeDescription?: servicefabric.ClusterUpgradePolicy;
  /** How many unused application type versions to keep. */
  applicationTypeVersionsCleanupPolicy?: servicefabric.ApplicationTypeVersionsCleanupPolicy;
  /** How Service Fabric upgrades nodes across availability zones. */
  sfZonalUpgradeMode?: servicefabric.SfZonalUpgradeMode;
  /** How the scale sets upgrade across availability zones. */
  vmssZonalUpgradeMode?: servicefabric.VmssZonalUpgradeMode;
  /** Enable the infrastructure service manager. */
  infrastructureServiceManager?: boolean;
  /** Release wave for automatic runtime upgrades (`Wave0`-`Wave2`). */
  upgradeWave?: servicefabric.ClusterUpgradeCadence;
  /** Pause automatic runtime upgrades. */
  waveUpgradePaused?: boolean;
  /** Start of a pause window for automatic upgrades (UTC timestamp). */
  upgradePauseStartTimestampUtc?: string;
  /** End of a pause window for automatic upgrades (UTC timestamp). */
  upgradePauseEndTimestampUtc?: string;
  /** Notification channels for cluster events. */
  notifications?: servicefabric.Notification[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.ServiceFabricClassic.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterResourceId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Service-generated unique identifier of the cluster. */
    clusterId: string | undefined;
    /** Resource Provider endpoint the cluster's system service connects to (pass it to the scale set's `ServiceFabricNode` extension). */
    clusterEndpoint: string | undefined;
    /** HTTP management endpoint of the cluster. */
    managementEndpoint: string;
    /** Cluster state, e.g. `WaitingForNodes`, `Deploying`, `Ready`. */
    clusterState: string | undefined;
    /** Service Fabric runtime version of the cluster. */
    clusterCodeVersion: string | undefined;
    /** Reliability level of the cluster. */
    reliabilityLevel: string | undefined;
    /** Add-on features enabled on the cluster. */
    addOnFeatures: string[];
    /** Operating system of the scale sets. */
    vmImage: string | undefined;
    /** Provisioning state of the cluster resource. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A classic Service Fabric cluster (`Microsoft.ServiceFabric/clusters`).
 *
 * The cluster resource describes the cluster; its nodes are virtual machine
 * scale sets you deploy separately with the `ServiceFabricNode` extension
 * pointing at the cluster's `clusterEndpoint`. Until they report in, the
 * cluster sits in `WaitingForNodes` and costs nothing. Microsoft recommends
 * Service Fabric managed clusters for new deployments.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/service-fabric-cluster-creation-via-arm
 *
 * ### Creating a Cluster
 * **Example:** Single-node test cluster
 * ```typescript
 * const cluster = yield* Azure.ServiceFabricClassic.Cluster("sf", {
 *   resourceGroup: group.resourceGroupName,
 *   reliabilityLevel: "None",
 *   nodeTypes: [
 *     {
 *       name: "nt1",
 *       isPrimary: true,
 *       vmInstanceCount: 1,
 *       clientConnectionEndpointPort: 19000,
 *       httpGatewayEndpointPort: 19080,
 *       applicationPorts: { startPort: 20000, endPort: 30000 },
 *       ephemeralPorts: { startPort: 49152, endPort: 65534 },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Securing a Cluster
 * **Example:** Certificate-secured cluster with add-ons
 * ```typescript
 * const cluster = yield* Azure.ServiceFabricClassic.Cluster("sf", {
 *   resourceGroup: group.resourceGroupName,
 *   reliabilityLevel: "Bronze",
 *   certificate: { thumbprint: "<cluster cert thumbprint>", x509StoreName: "My" },
 *   clientCertificateThumbprints: [
 *     { isAdmin: true, certificateThumbprint: "<admin cert thumbprint>" },
 *   ],
 *   addOnFeatures: ["RepairManager", "DnsService"],
 *   nodeTypes: [
 *     {
 *       name: "primary",
 *       isPrimary: true,
 *       vmInstanceCount: 3,
 *       clientConnectionEndpointPort: 19000,
 *       httpGatewayEndpointPort: 19080,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.ServiceFabricClassic.Cluster");

type ObservedCluster = servicefabric.GetClusterResponse | servicefabric.Cluster;

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  clusterResourceId: cluster.id ?? "",
  resourceGroup,
  location: cluster.location ?? "",
  clusterId: cluster.properties?.clusterId,
  clusterEndpoint: cluster.properties?.clusterEndpoint,
  managementEndpoint: cluster.properties?.managementEndpoint ?? "",
  clusterState: cluster.properties?.clusterState,
  clusterCodeVersion: cluster.properties?.clusterCodeVersion,
  reliabilityLevel: cluster.properties?.reliabilityLevel,
  addOnFeatures: [...(cluster.properties?.addOnFeatures ?? [])],
  vmImage: cluster.properties?.vmImage,
  provisioningState: cluster.properties?.provisioningState,
  tags: userTags(cluster.tags),
});

const defaultManagementEndpoint = (
  name: string,
  location: string,
  props: ClusterProps,
) => {
  const primary =
    props.nodeTypes.find((nodeType) => nodeType.isPrimary) ??
    props.nodeTypes[0];
  const scheme =
    props.certificate || props.certificateCommonNames ? "https" : "http";
  return `${scheme}://${name}.${lower(location)}.cloudapp.azure.com:${primary?.httpGatewayEndpointPort ?? 19080}`;
};

/** Properties the PATCH (UpdateCluster) accepts. */
const patchable = (props: ClusterProps) => ({
  addOnFeatures: props.addOnFeatures,
  certificate: props.certificate,
  certificateCommonNames: props.certificateCommonNames,
  clientCertificateCommonNames: props.clientCertificateCommonNames,
  clientCertificateThumbprints: props.clientCertificateThumbprints,
  clusterCodeVersion: props.clusterCodeVersion,
  eventStoreServiceEnabled: props.eventStoreServiceEnabled,
  fabricSettings: props.fabricSettings,
  nodeTypes: props.nodeTypes,
  reliabilityLevel: props.reliabilityLevel,
  reverseProxyCertificate: props.reverseProxyCertificate,
  upgradeDescription: props.upgradeDescription,
  applicationTypeVersionsCleanupPolicy:
    props.applicationTypeVersionsCleanupPolicy,
  upgradeMode: props.upgradeMode,
  sfZonalUpgradeMode: props.sfZonalUpgradeMode,
  vmssZonalUpgradeMode: props.vmssZonalUpgradeMode,
  infrastructureServiceManager: props.infrastructureServiceManager,
  upgradeWave: props.upgradeWave,
  upgradePauseStartTimestampUtc: props.upgradePauseStartTimestampUtc,
  upgradePauseEndTimestampUtc: props.upgradePauseEndTimestampUtc,
  waveUpgradePaused: props.waveUpgradePaused,
  notifications: props.notifications,
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterResourceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* servicefabric
        .ListClusters({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListClusters", page)));
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.clusterName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.managementEndpoint !== undefined &&
          lower(news.managementEndpoint) !== lower(output.managementEndpoint)) ||
        (news.vmImage !== undefined &&
          output.vmImage !== undefined &&
          lower(news.vmImage) !== lower(output.vmImage))
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
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
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
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const desired: servicefabric.ClusterPropertiesInput = {
        ...patchable(news),
        managementEndpoint:
          news.managementEndpoint ??
          defaultManagementEndpoint(name, location, news),
        vmImage: news.vmImage,
        azureActiveDirectory: news.azureActiveDirectory,
        diagnosticsStorageAccountConfig: news.diagnosticsStorageAccountConfig,
        reliabilityLevel: news.reliabilityLevel ?? "None",
        upgradeMode: news.upgradeMode ?? "Automatic",
      };
      const label = `service fabric cluster ${name}`;
      const waitReady = waitForProvisioned(
        label,
        getCluster(subscriptionId, resourceGroup, name),
        (cluster) => cluster.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* getCluster(subscriptionId, resourceGroup, name);

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* servicefabric.ClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: desired,
        });
      }
      observed = yield* waitReady;

      // Sync. Entra ID and diagnostics settings are not PATCHable: re-PUT
      // the full desired state when they drift.
      if (
        !matches(news.azureActiveDirectory, observed.properties?.azureActiveDirectory) ||
        !matches(
          news.diagnosticsStorageAccountConfig,
          observed.properties?.diagnosticsStorageAccountConfig,
        )
      ) {
        yield* servicefabric.ClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: desired,
        });
        observed = yield* waitReady;
      }

      // Every other property and tags: PATCH only the observed delta (each
      // property change starts a cluster upgrade).
      const properties = delta(
        {
          ...patchable(news),
          reliabilityLevel: desired.reliabilityLevel,
          upgradeMode: desired.upgradeMode,
        },
        observed.properties,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        yield* servicefabric.UpdateCluster({
          ...where,
          properties,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicefabric.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `service fabric cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
