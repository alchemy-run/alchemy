import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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

export interface CassandraClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 3-44 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the cluster.
   */
  name?: string;
  /**
   * Azure region of the cluster's management plane. Changing it replaces
   * the cluster.
   * @default the provider's default location
   */
  location?: string;
  /**
   * ARM ID of the subnet the cluster's management service attaches to,
   * e.g. `subnet.subnetId`. The "Azure Cosmos DB" service principal needs
   * `Network Contributor` on its virtual network, and the subnet must route
   * to every data center subnet. Changing it replaces the cluster.
   */
  delegatedManagementSubnetId: string;
  /**
   * Cassandra version the cluster converges to, e.g. `"4.0"` or `"5.0"`.
   * Upgrades are applied in place.
   * @default Azure's default version
   */
  cassandraVersion?: string;
  /**
   * Client authentication method. `None` disables authentication.
   * @default "Cassandra"
   */
  authenticationMethod?: "None" | "Cassandra" | "Ldap";
  /**
   * Initial password of the `cassandra` admin user. Only used when the
   * cluster is created (`authenticationMethod: "Cassandra"`); change it with
   * CQL afterwards.
   */
  initialCassandraAdminPassword?: Redacted.Redacted<string>;
  /**
   * Whether automatic repairs run. Disable only for hybrid clusters that
   * run their own repairs.
   * @default true
   */
  repairEnabled?: boolean;
  /** Whether Cassandra audit logging is enabled. */
  cassandraAuditLoggingEnabled?: boolean;
  /**
   * PEM-encoded certificates that clients must present a TLS certificate
   * signed by. Omit to accept any client (connections are always TLS).
   */
  clientCertificates?: string[];
  /** IP addresses of seed nodes in unmanaged (hybrid) data centers. */
  externalSeedNodes?: string[];
  /**
   * Give the cluster a system-assigned managed identity (e.g. for
   * customer-managed keys).
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /** Tags applied to the cluster. */
  tags?: Record<string, string>;
}

export interface CassandraCluster extends Resource<
  "Azure.CosmosDB.CassandraCluster",
  CassandraClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster (lowercase, no spaces, e.g. `eastus`). */
    location: string;
    /** ARM ID of the management subnet. */
    delegatedManagementSubnetId: string;
    /** Cassandra version the cluster runs. */
    cassandraVersion: string | undefined;
    /** IP addresses of the managed seed nodes, for hybrid clusters. */
    seedNodes: string[];
    /** Principal ID of the system-assigned identity, when enabled. */
    principalId: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Managed Instance for Apache Cassandra cluster. The cluster is
 * the control plane; nodes run in its {@link CassandraDataCenter}s, which
 * are billed per VM.
 *
 * The cluster's management subnet must let the "Azure Cosmos DB" service
 * principal (app ID `a232010e-820c-4083-83bb-3ace5fc29d0b`) manage it: grant
 * that principal `Network Contributor` on the virtual network first.
 *
 * @see https://learn.microsoft.com/azure/managed-instance-apache-cassandra/introduction
 *
 * ### Creating a Cluster
 * **Example:** Cluster on a dedicated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("cassandra", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.20.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("nodes", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.20.1.0/24",
 * });
 * yield* Azure.Authorization.RoleAssignment("cosmos-network", {
 *   scope: vnet.virtualNetworkId,
 *   roleDefinitionId: "4d97b98b-1d4f-4787-a291-c67834d212e7", // Network Contributor
 *   principalId: cosmosDbServicePrincipalObjectId,
 *   principalType: "ServicePrincipal",
 * });
 * const cluster = yield* Azure.CosmosDB.CassandraCluster("cassandra", {
 *   resourceGroup: group.resourceGroupName,
 *   delegatedManagementSubnetId: subnet.subnetId,
 *   cassandraVersion: "4.0",
 *   initialCassandraAdminPassword: yield* Config.redacted("CASSANDRA_PASSWORD"),
 * });
 * ```
 *
 * ### Hybrid Clusters
 * **Example:** Join existing on-premises data centers
 * ```typescript
 * const cluster = yield* Azure.CosmosDB.CassandraCluster("hybrid", {
 *   resourceGroup: group.resourceGroupName,
 *   delegatedManagementSubnetId: subnet.subnetId,
 *   externalSeedNodes: ["10.0.0.4", "10.0.0.5"],
 *   repairEnabled: false,
 * });
 * ```
 *
 * @resource
 */
export const CassandraCluster = Resource<CassandraCluster>(
  "Azure.CosmosDB.CassandraCluster",
);

type ObservedCluster = cosmos.GetCassandraClusterResponse;

const normalizeLocation = (location: string | undefined) =>
  (location ?? "").toLowerCase().replace(/\s+/g, "");

const createClusterName = Effect.fn(function* (id: string) {
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

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetCassandraCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  );

const sortedKey = (values: readonly (string | undefined)[] | undefined) =>
  (values ?? [])
    .flatMap((v) => (v ? [v.trim()] : []))
    .sort()
    .join("\n");

/**
 * The PATCH body needed to move the observed cluster to the desired
 * properties; empty when converged. Unset props are left as observed.
 */
const propertyDelta = (
  news: CassandraClusterProps,
  observed: { properties?: cosmos.ClusterResourceProperties },
): cosmos.ClusterResourcePropertiesInput => {
  const props = observed.properties ?? {};
  const delta: cosmos.ClusterResourcePropertiesInput = {};
  if (
    news.cassandraVersion !== undefined &&
    props.cassandraVersion !== news.cassandraVersion
  ) {
    delta.cassandraVersion = news.cassandraVersion;
  }
  if (
    news.authenticationMethod !== undefined &&
    props.authenticationMethod !== news.authenticationMethod
  ) {
    delta.authenticationMethod = news.authenticationMethod;
  }
  if (
    news.repairEnabled !== undefined &&
    props.repairEnabled !== news.repairEnabled
  ) {
    delta.repairEnabled = news.repairEnabled;
  }
  if (
    news.cassandraAuditLoggingEnabled !== undefined &&
    props.cassandraAuditLoggingEnabled !== news.cassandraAuditLoggingEnabled
  ) {
    delta.cassandraAuditLoggingEnabled = news.cassandraAuditLoggingEnabled;
  }
  if (
    news.clientCertificates !== undefined &&
    sortedKey(news.clientCertificates) !==
      sortedKey(props.clientCertificates?.map((c) => c.pem))
  ) {
    delta.clientCertificates = news.clientCertificates.map((pem) => ({ pem }));
  }
  if (
    news.externalSeedNodes !== undefined &&
    sortedKey(news.externalSeedNodes) !==
      sortedKey(props.externalSeedNodes?.map((n) => n.ipAddress))
  ) {
    delta.externalSeedNodes = news.externalSeedNodes.map((ipAddress) => ({
      ipAddress,
    }));
  }
  return delta;
};

const identityType = (news: CassandraClusterProps) =>
  news.systemAssignedIdentity ? "SystemAssigned" : "None";

const identityDiffers = (
  news: CassandraClusterProps,
  observed: ObservedCluster,
) =>
  news.systemAssignedIdentity !== undefined &&
  (observed.identity?.type ?? "None") !== identityType(news);

const isEmpty = (value: object) => Object.keys(value).length === 0;

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster | cosmos.ClusterResource,
): CassandraCluster["Attributes"] => ({
  clusterName: name,
  clusterId: cluster.id ?? "",
  resourceGroup,
  location: normalizeLocation(cluster.location),
  delegatedManagementSubnetId:
    cluster.properties?.delegatedManagementSubnetId ?? "",
  cassandraVersion: cluster.properties?.cassandraVersion,
  seedNodes: (cluster.properties?.seedNodes ?? []).flatMap((n) =>
    n.ipAddress ? [n.ipAddress] : [],
  ),
  principalId: cluster.identity?.principalId,
  provisioningState: cluster.properties?.provisioningState,
  tags: userTags(cluster.tags),
});

// Cluster creation and deletion take 10-15 minutes, but the regional
// operation queue has held creates in `Creating` for 25+ minutes.
const BUDGET = { interval: "15 seconds", times: 240 } as const;

export const CassandraClusterProvider = () =>
  Provider.succeed(CassandraCluster, {
    stables: [
      "clusterName",
      "clusterId",
      "resourceGroup",
      "location",
      "delegatedManagementSubnetId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cosmos
        .ListCassandraClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCassandraClusterBySubscription", page),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== output.location) ||
        news.delegatedManagementSubnetId.toLowerCase() !==
          output.delegatedManagementSubnetId.toLowerCase()
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
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.location,
      );
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `Cassandra cluster ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);
      const settled = (cluster: ObservedCluster) =>
        cluster.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* cosmos.CassandraClustersCreateUpdate({
          ...where,
          location,
          tags,
          identity: { type: identityType(news) },
          properties: {
            ...propertyDelta(news, {}),
            delegatedManagementSubnetId: news.delegatedManagementSubnetId,
            initialCassandraAdminPassword: news.initialCassandraAdminPassword,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, settled, BUDGET);

      // Sync mutable properties, identity, and tags against observed state.
      const delta = propertyDelta(news, observed);
      const syncIdentity = identityDiffers(news, observed);
      const syncTags = tagsDiffer(observed.tags, tags);
      if (!isEmpty(delta) || syncIdentity || syncTags) {
        yield* cosmos.UpdateCassandraCluster({
          ...where,
          tags: syncTags ? tags : undefined,
          identity: syncIdentity ? { type: identityType(news) } : undefined,
          properties: isEmpty(delta) ? undefined : delta,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (cluster) =>
            isEmpty(propertyDelta(news, cluster)) &&
            !identityDiffers(news, cluster) &&
            !tagsDiffer(cluster.tags, tags)
              ? settled(cluster)
              : "Updating",
          BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos.DeleteCassandraCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `Cassandra cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.Subnet",
        "Azure.Network.VirtualNetwork",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
