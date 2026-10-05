import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  canonical,
  getCluster,
  lower,
  normalizeLocation,
  reveal,
} from "./Common.ts";

/** Workload type of an HDInsight cluster. */
export type ClusterKind =
  | "hadoop"
  | "spark"
  | "kafka"
  | "hbase"
  | "interactivehive"
  | (string & {});

export type ClusterAutoscale = hdinsight.Autoscale;

/**
 * Default (primary) storage of the cluster: a blob container accessed with
 * an account key (WASB), or an Azure Data Lake Storage Gen2 file system
 * accessed with a user-assigned managed identity.
 */
export type ClusterStorage =
  | {
      /** WASB storage (a general-purpose v2 account and blob container). */
      type: "Blob";
      /** Name of the storage account (not the endpoint). */
      storageAccountName: string;
      /** Blob container used as the cluster's file system root. */
      container: string;
      /** Storage account access key. */
      key: Redacted.Redacted<string>;
      /** ARM resource ID of the storage account. */
      storageAccountId?: string;
    }
  | {
      /** ADLS Gen2 storage (a hierarchical-namespace account). */
      type: "DataLakeGen2";
      /** Name of the storage account (not the endpoint). */
      storageAccountName: string;
      /** ADLS Gen2 file system (container) used as the root. */
      fileSystem: string;
      /** ARM resource ID of the storage account. */
      storageAccountId: string;
      /**
       * ARM resource ID of the user-assigned managed identity that holds
       * `Storage Blob Data Owner` on the account. It is attached to the
       * cluster automatically.
       */
      managedIdentityId: string;
    };

/** A node role's virtual machine size. */
export interface ClusterNodeProfile {
  /**
   * Virtual machine size of the role's nodes.
   * @default "Standard_E4_v3"
   */
  vmSize?: string;
}

/** Worker nodes of the cluster. */
export interface ClusterWorkerNodeProfile extends ClusterNodeProfile {
  /**
   * Number of worker nodes. Changing it resizes the cluster in place.
   * Ignored while `autoscale` is set.
   * @default 1
   */
  count?: number;
  /**
   * Load- or schedule-based autoscale. Updated in place; removing it
   * disables autoscale.
   */
  autoscale?: ClusterAutoscale;
  /**
   * Managed data disks per worker node (required for Kafka clusters).
   * Changing it replaces the cluster.
   */
  disksPerNode?: number;
}

/** Virtual network the cluster's nodes join. */
export interface ClusterVirtualNetwork {
  /** ARM resource ID of the virtual network. */
  id: string;
  /** ARM resource ID of the subnet. */
  subnet: string;
}

/** Managed identities attached to the cluster. */
export interface ClusterIdentity {
  /** Identity type. */
  type: "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned";
  /** ARM resource IDs of user-assigned identities. */
  userAssignedIdentityIds?: string[];
}

export interface ClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Globally unique cluster name (`<name>.azurehdinsight.net`): 3-45
   * letters, digits, and hyphens, starting with a letter. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones of the cluster. Changing them replaces the cluster. */
  zones?: string[];
  /** Workload type. Changing it replaces the cluster. */
  kind: ClusterKind;
  /**
   * HDInsight version. Changing it replaces the cluster.
   * @default "5.1"
   */
  clusterVersion?: string;
  /**
   * Versions of the workload components, e.g. `{ Spark: "3.3" }`. Changing
   * them replaces the cluster.
   */
  componentVersion?: Record<string, string>;
  /**
   * Cluster tier. Changing it replaces the cluster.
   * @default "Standard"
   */
  tier?: "Standard" | "Premium";
  /**
   * User name of the cluster gateway (Ambari, the REST endpoints). Updated
   * in place.
   * @default "admin"
   */
  gatewayUsername?: string;
  /**
   * Password of the cluster gateway: at least 10 characters with upper,
   * lower, digit, and symbol. Updated in place.
   */
  gatewayPassword: Redacted.Redacted<string>;
  /**
   * SSH user of the cluster nodes. Changing it replaces the cluster.
   * @default "sshuser"
   */
  sshUsername?: string;
  /**
   * SSH password of the cluster nodes. Changing it replaces the cluster.
   * @default `gatewayPassword` when `sshPublicKey` is not given
   */
  sshPassword?: Redacted.Redacted<string>;
  /** SSH public key (OpenSSH format). Changing it replaces the cluster. */
  sshPublicKey?: string;
  /** Head nodes (always two). Changing them replaces the cluster. */
  headNode?: ClusterNodeProfile;
  /** Worker nodes. */
  workerNode?: ClusterWorkerNodeProfile;
  /**
   * ZooKeeper nodes (three). Omit to let HDInsight pick its default size.
   * Changing them replaces the cluster.
   */
  zookeeperNode?: ClusterNodeProfile;
  /** Default storage. Changing the account or container replaces the cluster. */
  storage: ClusterStorage;
  /** Virtual network for every node. Changing it replaces the cluster. */
  virtualNetwork?: ClusterVirtualNetwork;
  /** Managed identities. Changing them replaces the cluster. */
  identity?: ClusterIdentity;
  /**
   * Extra cluster configurations keyed by configuration file, e.g.
   * `{ "core-site": { "fs.trash.interval": "60" } }`. Changing them
   * replaces the cluster.
   */
  configurations?: Record<string, Record<string, string>>;
  /**
   * Minimum TLS version of the public endpoints. Changing it replaces the
   * cluster.
   * @default Azure's default (`1.2`)
   */
  minSupportedTlsVersion?: string;
  /**
   * Encrypt traffic between cluster nodes. Changing it replaces the
   * cluster.
   * @default false
   */
  encryptionInTransit?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** An endpoint of the cluster (SSH, HTTPS gateway, ...). */
export interface ClusterConnectivityEndpoint {
  /** Endpoint name, e.g. `HTTPS` or `SSH`. */
  name: string | undefined;
  /** Protocol of the endpoint. */
  protocol: string | undefined;
  /** Host name of the endpoint. */
  location: string | undefined;
  /** Port of the endpoint. */
  port: number | undefined;
  /** Private IP address of the endpoint. */
  privateIPAddress: string | undefined;
}

export interface Cluster extends Resource<
  "Azure.HDInsight.Cluster",
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
    /** Workload type. */
    kind: string;
    /** HDInsight version. */
    clusterVersion: string;
    /** Internal HDInsight cluster ID. */
    hdinsightClusterId: string | undefined;
    /** Cluster state, e.g. `Running`. */
    clusterState: string | undefined;
    /** Number of worker nodes currently requested. */
    workerNodeCount: number | undefined;
    /** Gateway URL, e.g. `https://<name>.azurehdinsight.net`. */
    url: string;
    /** SSH host, e.g. `<name>-ssh.azurehdinsight.net`. */
    sshHost: string | undefined;
    /** Every connectivity endpoint of the cluster. */
    connectivityEndpoints: ClusterConnectivityEndpoint[];
    /** Principal ID of the system-assigned identity, if any. */
    identityPrincipalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure HDInsight cluster — a managed Hadoop, Spark, Kafka, HBase, or
 * Interactive Query cluster on Azure virtual machines, with Azure Storage
 * or Data Lake Storage Gen2 as its file system.
 *
 * Clusters take 20+ minutes to provision and bill for every node while
 * they exist (two head nodes, the worker nodes, and ZooKeeper nodes).
 * Changing the worker count, autoscale, gateway credentials, or tags is
 * applied in place; every other change replaces the cluster.
 *
 * @see https://learn.microsoft.com/azure/hdinsight/hdinsight-overview
 *
 * ### Creating a Cluster
 * **Example:** Spark cluster on a blob container
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const account = yield* Azure.Storage.StorageAccount("lake", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const container = yield* Azure.Storage.BlobContainer("spark", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * const cluster = yield* Azure.HDInsight.Cluster("spark", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "spark",
 *   gatewayPassword: Redacted.make(process.env.HDI_PASSWORD!),
 *   storage: {
 *     type: "Blob",
 *     storageAccountName: account.storageAccountName,
 *     container: container.containerName,
 *     key: accountKey,
 *   },
 * });
 * ```
 *
 * **Example:** Kafka cluster with managed disks and ZooKeeper nodes
 * ```typescript
 * const kafka = yield* Azure.HDInsight.Cluster("kafka", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "kafka",
 *   gatewayPassword,
 *   workerNode: { count: 3, disksPerNode: 2 },
 *   zookeeperNode: { vmSize: "Standard_A4_v2" },
 *   storage,
 * });
 * ```
 *
 * ### Scaling
 * **Example:** Resize the worker nodes in place
 * ```typescript
 * const cluster = yield* Azure.HDInsight.Cluster("spark", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "spark",
 *   gatewayPassword,
 *   workerNode: { count: 4 },
 *   storage,
 * });
 * ```
 *
 * **Example:** Load-based autoscale
 * ```typescript
 * const cluster = yield* Azure.HDInsight.Cluster("spark", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "spark",
 *   gatewayPassword,
 *   workerNode: {
 *     autoscale: { capacity: { minInstanceCount: 3, maxInstanceCount: 10 } },
 *   },
 *   storage,
 * });
 * ```
 *
 * ### Data Lake Storage Gen2
 * **Example:** Cluster on an ADLS Gen2 file system
 * ```typescript
 * const cluster = yield* Azure.HDInsight.Cluster("hadoop", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "hadoop",
 *   gatewayPassword,
 *   storage: {
 *     type: "DataLakeGen2",
 *     storageAccountName: lake.storageAccountName,
 *     fileSystem: "hadoop",
 *     storageAccountId: lake.storageAccountId,
 *     managedIdentityId: identity.identityId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.HDInsight.Cluster");

type ObservedCluster = hdinsight.GetClusterResponse;

const DEFAULT_VM_SIZE = "Standard_E4_v3";

const createClusterName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    // ARM rejects cluster names over 45 characters.
    maxLength: 45,
    lowercase: true,
  }))
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `h${name.slice(1)}`;
});

const roleOf = (cluster: ObservedCluster, role: string) =>
  cluster.properties?.computeProfile?.roles?.find(
    (r) => r.name?.toLowerCase() === role,
  );

/**
 * Ready once provisioning succeeded and the cluster is `Running` (a resize
 * or gateway update moves it back through intermediate states).
 */
const clusterStateOf = (cluster: ObservedCluster) => {
  const provisioning = cluster.properties?.provisioningState;
  if (provisioning !== undefined && provisioning !== "Succeeded") {
    return provisioning;
  }
  const state = cluster.properties?.clusterState;
  if (state === undefined || state === "Running") return "Succeeded";
  if (state === "Error") return "Failed";
  return state;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): Cluster["Attributes"] => {
  const props = cluster.properties;
  const endpoints = (props?.connectivityEndpoints ?? []).map((e) => ({
    name: e.name,
    protocol: e.protocol,
    location: e.location,
    port: e.port,
    privateIPAddress: e.privateIPAddress,
  }));
  return {
    clusterName: name,
    clusterId: cluster.id ?? "",
    resourceGroup,
    location: cluster.location,
    kind: props?.clusterDefinition?.kind ?? "",
    clusterVersion: props?.clusterVersion ?? "",
    hdinsightClusterId: props?.clusterId,
    clusterState: props?.clusterState,
    workerNodeCount: roleOf(cluster, "workernode")?.targetInstanceCount,
    url: `https://${name}.azurehdinsight.net`,
    sshHost: endpoints.find((e) => e.name?.toUpperCase() === "SSH")?.location,
    connectivityEndpoints: endpoints,
    identityPrincipalId: cluster.identity?.principalId,
    tags: userTags(cluster.tags),
  };
};

/**
 * Everything that can only be set at creation; any change replaces the
 * cluster. Secrets are compared in memory only.
 */
const immutableSignature = (props: ClusterProps) =>
  canonical({
    kind: props.kind.toLowerCase(),
    clusterVersion: props.clusterVersion ?? "5.1",
    componentVersion: props.componentVersion,
    tier: props.tier ?? "Standard",
    zones: props.zones,
    sshUsername: props.sshUsername ?? "sshuser",
    sshPassword: reveal(props.sshPassword),
    sshPublicKey: props.sshPublicKey,
    headNode: props.headNode?.vmSize ?? DEFAULT_VM_SIZE,
    workerNode: props.workerNode?.vmSize ?? DEFAULT_VM_SIZE,
    disksPerNode: props.workerNode?.disksPerNode,
    zookeeperNode: props.zookeeperNode?.vmSize,
    storage:
      props.storage.type === "Blob"
        ? {
            type: "Blob",
            account: lower(props.storage.storageAccountName),
            container: props.storage.container,
          }
        : {
            type: "DataLakeGen2",
            account: lower(props.storage.storageAccountName),
            fileSystem: props.storage.fileSystem,
            identity: lower(props.storage.managedIdentityId),
          },
    virtualNetwork: props.virtualNetwork && {
      id: lower(props.virtualNetwork.id),
      subnet: lower(props.virtualNetwork.subnet),
    },
    identity: props.identity && {
      type: props.identity.type,
      ids: (props.identity.userAssignedIdentityIds ?? [])
        .map((id) => id.toLowerCase())
        .sort(),
    },
    configurations: props.configurations,
    minSupportedTlsVersion: props.minSupportedTlsVersion,
    encryptionInTransit: props.encryptionInTransit ?? false,
  });

const storageAccountInput = (
  storage: ClusterStorage,
): hdinsight.StorageAccount =>
  storage.type === "Blob"
    ? {
        name: `${storage.storageAccountName}.blob.core.windows.net`,
        isDefault: true,
        container: storage.container,
        key: Redacted.value(storage.key),
        resourceId: storage.storageAccountId,
      }
    : {
        name: `${storage.storageAccountName}.dfs.core.windows.net`,
        isDefault: true,
        fileSystem: storage.fileSystem,
        resourceId: storage.storageAccountId,
        msiResourceId: storage.managedIdentityId,
      };

const identityInput = (
  news: ClusterProps,
): hdinsight.ClusterIdentityInput | undefined => {
  const ids = [...(news.identity?.userAssignedIdentityIds ?? [])];
  const storageIdentity =
    news.storage.type === "DataLakeGen2"
      ? news.storage.managedIdentityId
      : undefined;
  if (
    storageIdentity !== undefined &&
    !ids.some((id) => id.toLowerCase() === storageIdentity.toLowerCase())
  ) {
    ids.push(storageIdentity);
  }
  const hasSystem = news.identity?.type.includes("SystemAssigned") ?? false;
  if (ids.length === 0) {
    return hasSystem ? { type: "SystemAssigned" } : undefined;
  }
  return {
    type: hasSystem ? "SystemAssigned, UserAssigned" : "UserAssigned",
    userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
  };
};

const createProperties = (
  news: ClusterProps,
  gatewayUsername: string,
): hdinsight.ClusterCreatePropertiesInput => {
  const sshUser = news.sshUsername ?? "sshuser";
  const osProfile: hdinsight.OsProfile = {
    linuxOperatingSystemProfile: news.sshPublicKey
      ? {
          username: sshUser,
          sshProfile: { publicKeys: [{ certificateData: news.sshPublicKey }] },
        }
      : {
          username: sshUser,
          password: Redacted.value(news.sshPassword ?? news.gatewayPassword),
        },
  };
  const virtualNetworkProfile = news.virtualNetwork && {
    id: news.virtualNetwork.id,
    subnet: news.virtualNetwork.subnet,
  };
  const role = (
    name: string,
    vmSize: string,
    targetInstanceCount: number,
    extra: Partial<hdinsight.RoleInput> = {},
  ): hdinsight.RoleInput => ({
    name,
    targetInstanceCount,
    hardwareProfile: { vmSize },
    osProfile,
    virtualNetworkProfile,
    ...extra,
  });
  const worker = news.workerNode;
  const roles: hdinsight.RoleInput[] = [
    role("headnode", news.headNode?.vmSize ?? DEFAULT_VM_SIZE, 2),
    role(
      "workernode",
      worker?.vmSize ?? DEFAULT_VM_SIZE,
      worker?.autoscale?.capacity?.minInstanceCount ?? worker?.count ?? 1,
      {
        autoscale: worker?.autoscale,
        dataDisksGroups:
          worker?.disksPerNode !== undefined
            ? [{ disksPerNode: worker.disksPerNode }]
            : undefined,
      },
    ),
  ];
  if (news.zookeeperNode !== undefined) {
    roles.push(
      role("zookeepernode", news.zookeeperNode.vmSize ?? DEFAULT_VM_SIZE, 3),
    );
  }
  return {
    clusterVersion: news.clusterVersion ?? "5.1",
    osType: "Linux",
    tier: news.tier ?? "Standard",
    clusterDefinition: {
      kind: news.kind,
      componentVersion: news.componentVersion,
      configurations: {
        ...news.configurations,
        gateway: {
          "restAuthCredential.isEnabled": true,
          "restAuthCredential.username": gatewayUsername,
          "restAuthCredential.password": Redacted.value(news.gatewayPassword),
        },
      },
    },
    computeProfile: { roles },
    storageProfile: { storageaccounts: [storageAccountInput(news.storage)] },
    minSupportedTlsVersion: news.minSupportedTlsVersion,
    encryptionInTransitProperties:
      news.encryptionInTransit !== undefined
        ? { isEncryptionInTransitEnabled: news.encryptionInTransit }
        : undefined,
  };
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location", "url"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hdinsight
        .ListClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListClusters", page)),
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
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.clusterName.toLowerCase()) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location)) ||
        (output.kind !== "" &&
          news.kind.toLowerCase() !== output.kind.toLowerCase()) ||
        (olds !== undefined &&
          immutableSignature(news) !== immutableSignature(olds))
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
      yield* ensureRegistered(subscriptionId, "Microsoft.HDInsight");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const gatewayUsername = news.gatewayUsername ?? "admin";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `HDInsight cluster ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);
      // Creation takes 20+ minutes; resizes and gateway updates 5-15.
      const settle = waitForProvisioned(label, get, clusterStateOf, {
        interval: "30 seconds",
        times: 60,
      });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* hdinsight.CreateCluster({
          ...where,
          location,
          tags,
          zones: news.zones,
          identity: identityInput(news),
          properties: createProperties(news, gatewayUsername),
        });
      }
      observed = yield* settle;

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hdinsight.UpdateCluster({ ...where, tags });
      }

      // Sync worker autoscale / count against the observed worker role.
      const worker = roleOf(observed, "workernode");
      const desiredAutoscale = news.workerNode?.autoscale;
      if (canonical(worker?.autoscale) !== canonical(desiredAutoscale)) {
        yield* hdinsight.UpdateClusterAutoScaleConfiguration({
          ...where,
          roleName: "workernode",
          autoscale: desiredAutoscale,
        });
        observed = yield* settle;
      }
      const desiredCount = news.workerNode?.count ?? 1;
      if (
        desiredAutoscale === undefined &&
        roleOf(observed, "workernode")?.targetInstanceCount !== desiredCount
      ) {
        yield* hdinsight.ResizeCluster({
          ...where,
          roleName: "workernode",
          targetInstanceCount: desiredCount,
        });
        observed = yield* settle;
      }

      // Sync gateway credentials against the observed gateway settings.
      const gateway = yield* hdinsight.GetClusterGatewaySettings(where);
      if (
        gateway.restAuthCredential_username !== gatewayUsername ||
        reveal(gateway.restAuthCredential_password) !==
          Redacted.value(news.gatewayPassword)
      ) {
        yield* hdinsight.UpdateClusterGatewaySettings({
          ...where,
          restAuthCredential_isEnabled: true,
          restAuthCredential_username: gatewayUsername,
          restAuthCredential_password: news.gatewayPassword,
        });
        observed = yield* settle;
      }

      observed = (yield* get) ?? observed;
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hdinsight.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      // Deleting the nodes takes 10-20 minutes.
      yield* waitUntilGone(
        `HDInsight cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "30 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
