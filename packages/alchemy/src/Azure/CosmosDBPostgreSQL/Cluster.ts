import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
  ProvisioningTimedOut,
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
  type ClusterRef,
  COSMOS_POSTGRES_NAMESPACE,
  generatePassword,
  getCluster,
  reveal,
  whileClusterBusy,
} from "./common.ts";

/** Weekly maintenance window of a cluster. */
export interface ClusterMaintenanceWindow {
  /** `Enabled` for a custom window, `Disabled` for the system-managed one. */
  customWindow?: "Enabled" | "Disabled";
  /** Start hour (0-23, UTC). */
  startHour?: number;
  /** Start minute (0-59). */
  startMinute?: number;
  /** Day of the week (0 = Sunday … 6 = Saturday). */
  dayOfWeek?: number;
}

export interface ClusterProps {
  /** Resource group that holds the cluster. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 3-40 lowercase letters, digits, and hyphens, globally
   * unique (it forms the `c-{name}.{hash}.postgres.cosmos.azure.com` host).
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure region. Changing it replaces the cluster.
   * @default the provider's default location
   */
  location?: string;
  /**
   * Password of the built-in `citus` administrator. If omitted, a random
   * password is generated on create and exposed as an attribute.
   */
  administratorLoginPassword?: Redacted.Redacted<string>;
  /**
   * PostgreSQL major version. Can only be raised in place; lowering it
   * replaces the cluster.
   * @default "16"
   */
  postgresqlVersion?: string;
  /** Citus extension version, e.g. `12.1`. */
  citusVersion?: string;
  /**
   * Edition of the coordinator: `BurstableMemoryOptimized`,
   * `BurstableGeneralPurpose`, `GeneralPurpose`, or `MemoryOptimized`.
   * Burstable editions are for single-node clusters only.
   * @default "BurstableMemoryOptimized"
   */
  coordinatorServerEdition?: string;
  /**
   * Coordinator vCores (1-2 for Burstable, up to 96 otherwise).
   * @default 1
   */
  coordinatorVCores?: number;
  /**
   * Coordinator storage in MiB (`32768`, `65536`, `131072`, …). Can only
   * grow in place.
   * @default 32768
   */
  coordinatorStorageQuotaInMb?: number;
  /**
   * Allow public connections to the coordinator (gated by firewall rules).
   * @default true
   */
  coordinatorEnablePublicIpAccess?: boolean;
  /**
   * Number of worker nodes: `0` for a single-node cluster, or 2 and more.
   * It cannot be 1 and cannot decrease in place (lowering it replaces the
   * cluster).
   * @default 0
   */
  nodeCount?: number;
  /** Edition of the worker nodes (`MemoryOptimized`, `GeneralPurpose`). */
  nodeServerEdition?: string;
  /** vCores of each worker node (up to 104). */
  nodeVCores?: number;
  /** Storage of each worker node in MiB. Can only grow in place. */
  nodeStorageQuotaInMb?: number;
  /**
   * Allow public connections to the worker nodes. Changing it replaces the
   * cluster.
   */
  nodeEnablePublicIpAccess?: boolean;
  /** Enable high availability (a standby for every server). */
  enableHa?: boolean;
  /**
   * Place distributed table shards on the coordinator. Azure turns it on for
   * single-node clusters.
   */
  enableShardsOnCoordinator?: boolean;
  /** Preferred availability zone of the primary servers. */
  preferredPrimaryZone?: string;
  /** Weekly maintenance window. */
  maintenanceWindow?: ClusterMaintenanceWindow;
  /**
   * Resource ID of the source cluster, to create a read replica or a
   * point-in-time restore. Changing it replaces the cluster.
   */
  sourceResourceId?: string;
  /** Region of the source cluster. Changing it replaces the cluster. */
  sourceLocation?: string;
  /**
   * Restore point (ISO 8601) for a point-in-time restore of
   * `sourceResourceId`. Changing it replaces the cluster.
   */
  pointInTimeUTC?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** A server of the cluster. */
export interface ClusterServerName {
  /** Server name, e.g. `{cluster}-c` for the coordinator. */
  name: string | undefined;
  /** Host name of the server. */
  fullyQualifiedDomainName: string | undefined;
}

export interface Cluster extends Resource<
  "Azure.CosmosDBPostgreSQL.Cluster",
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
    /** Cluster state (`Ready`, `Stopped`, …). */
    state: string | undefined;
    /** PostgreSQL major version. */
    postgresqlVersion: string | undefined;
    /** Citus extension version. */
    citusVersion: string | undefined;
    /** Login of the built-in administrator (`citus`). */
    administratorLogin: string | undefined;
    /**
     * Administrator password last applied by Alchemy (the given or the
     * generated one). `undefined` for adopted clusters.
     */
    administratorLoginPassword: Redacted.Redacted<string> | undefined;
    /** Host name of the coordinator, the cluster's connection endpoint. */
    coordinatorFullyQualifiedDomainName: string | undefined;
    /**
     * `postgresql://` connection string for the administrator and the
     * `citus` database, with `sslmode=require`.
     */
    connectionString: Redacted.Redacted<string> | undefined;
    /** Servers of the cluster (coordinator and worker nodes). */
    serverNames: ClusterServerName[];
    /** Resource IDs of read replica clusters. */
    readReplicas: string[];
    /** Earliest point-in-time restore point (ISO 8601). */
    earliestRestoreTime: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Cosmos DB for PostgreSQL cluster (distributed PostgreSQL with
 * the Citus extension).
 *
 * Clusters default to the cheapest configuration — a single-node cluster
 * with a Burstable 1-vCore coordinator, 32 GiB storage, PostgreSQL 16, and
 * public access with no firewall rules (add
 * `CosmosDBPostgreSQL.FirewallRule`s to let clients in). Creation takes
 * 10-20 minutes.
 *
 * Cosmos DB for PostgreSQL is retiring: Azure no longer provisions new
 * clusters and rejects the create with `CosmosPostgresProvisioningRetired`.
 * Existing clusters can still be adopted and managed (scaling, tags,
 * maintenance, roles, firewall rules, parameters), and point-in-time
 * restores and read replicas (`sourceResourceId`) remain available. New
 * workloads should use `Azure.PostgreSQL.FlexibleServer` (elastic clusters).
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/postgresql/introduction
 *
 * ### Creating a Cluster
 * **Example:** Single-node cluster with a generated password
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const cluster = yield* Azure.CosmosDBPostgreSQL.Cluster("db", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // cluster.connectionString is a Redacted postgresql:// URL
 * ```
 *
 * **Example:** Multi-node cluster
 * ```typescript
 * const cluster = yield* Azure.CosmosDBPostgreSQL.Cluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   coordinatorServerEdition: "GeneralPurpose",
 *   coordinatorVCores: 4,
 *   coordinatorStorageQuotaInMb: 131072,
 *   nodeCount: 2,
 *   nodeServerEdition: "MemoryOptimized",
 *   nodeVCores: 4,
 *   nodeStorageQuotaInMb: 524288,
 *   administratorLoginPassword: yield* Config.redacted("CITUS_PASSWORD"),
 * });
 * ```
 *
 * ### Maintenance
 * **Example:** Custom maintenance window
 * ```typescript
 * const cluster = yield* Azure.CosmosDBPostgreSQL.Cluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   maintenanceWindow: {
 *     customWindow: "Enabled",
 *     dayOfWeek: 0,
 *     startHour: 2,
 *     startMinute: 0,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.CosmosDBPostgreSQL.Cluster");

type ObservedCluster = postgresqlhsc.GetClusterResponse;

const DEFAULTS = {
  postgresqlVersion: "16",
  coordinatorServerEdition: "BurstableMemoryOptimized",
  coordinatorVCores: 1,
  coordinatorStorageQuotaInMb: 32768,
  coordinatorEnablePublicIpAccess: true,
  nodeCount: 0,
} as const;

const createClusterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 40,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const lower = (value: string | undefined) => value?.toLowerCase();

/** ARM may report locations by display name (`Central US`). */
const normalizeLocation = (value: string | undefined) =>
  value?.replace(/\s+/g, "").toLowerCase();

const coordinatorOf = (cluster: ObservedCluster) => {
  const servers = cluster.properties?.serverNames ?? [];
  return (
    servers.find((s) => s.fullyQualifiedDomainName?.startsWith("c-")) ??
    servers.find((s) => s.name?.endsWith("-c")) ??
    servers[0]
  );
};

const connectionStringOf = (
  login: string | undefined,
  password: Redacted.Redacted<string> | undefined,
  fqdn: string | undefined,
) =>
  login !== undefined && password !== undefined && fqdn
    ? Redacted.make(
        `postgresql://${encodeURIComponent(login)}:${encodeURIComponent(
          Redacted.value(password),
        )}@${fqdn}:5432/citus?sslmode=require`,
      )
    : undefined;

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
  password: Redacted.Redacted<string> | undefined,
): Cluster["Attributes"] => {
  const props = cluster.properties ?? {};
  const fqdn = coordinatorOf(cluster)?.fullyQualifiedDomainName;
  return {
    clusterName: name,
    clusterId: cluster.id ?? "",
    resourceGroup,
    location: cluster.location,
    state: props.state,
    postgresqlVersion: props.postgresqlVersion,
    citusVersion: props.citusVersion,
    administratorLogin: props.administratorLogin,
    administratorLoginPassword: password,
    coordinatorFullyQualifiedDomainName: fqdn,
    connectionString: connectionStringOf(
      props.administratorLogin,
      password,
      fqdn,
    ),
    serverNames: (props.serverNames ?? []).map((s) => ({
      name: s.name,
      fullyQualifiedDomainName: s.fullyQualifiedDomainName,
    })),
    readReplicas: [...(props.readReplicas ?? [])],
    earliestRestoreTime: props.earliestRestoreTime,
    tags: userTags(cluster.tags),
  };
};

type UpdateDelta = Omit<
  postgresqlhsc.UpdateClusterRequest,
  "subscriptionId" | "resourceGroupName" | "clusterName"
>;

/**
 * The PATCH body that moves `observed` to the desired state, or an empty
 * object when the cluster already matches. Only explicitly set props are
 * synced, so adopted clusters keep unspecified settings. The password is
 * not observable and is handled by the caller.
 */
const clusterDelta = (
  observed: ObservedCluster,
  news: ClusterProps,
  tags: Record<string, string>,
): UpdateDelta => {
  const props = observed.properties ?? {};
  const properties: postgresqlhsc.ClusterPropertiesForUpdateInput = {};
  const set = <K extends keyof postgresqlhsc.ClusterPropertiesForUpdateInput>(
    key: K,
    desired: postgresqlhsc.ClusterPropertiesForUpdateInput[K] | undefined,
    current: unknown,
  ) => {
    if (desired !== undefined && desired !== current) properties[key] = desired;
  };

  if (
    news.postgresqlVersion !== undefined &&
    Number(news.postgresqlVersion) > Number(props.postgresqlVersion ?? 0)
  ) {
    properties.postgresqlVersion = news.postgresqlVersion;
  }
  set("citusVersion", news.citusVersion, props.citusVersion);
  set(
    "coordinatorServerEdition",
    news.coordinatorServerEdition,
    props.coordinatorServerEdition,
  );
  set("coordinatorVCores", news.coordinatorVCores, props.coordinatorVCores);
  if (
    news.coordinatorStorageQuotaInMb !== undefined &&
    news.coordinatorStorageQuotaInMb > (props.coordinatorStorageQuotaInMb ?? 0)
  ) {
    properties.coordinatorStorageQuotaInMb = news.coordinatorStorageQuotaInMb;
  }
  set(
    "coordinatorEnablePublicIpAccess",
    news.coordinatorEnablePublicIpAccess,
    props.coordinatorEnablePublicIpAccess,
  );
  if (news.nodeCount !== undefined && news.nodeCount > (props.nodeCount ?? 0)) {
    properties.nodeCount = news.nodeCount;
  }
  set("nodeServerEdition", news.nodeServerEdition, props.nodeServerEdition);
  set("nodeVCores", news.nodeVCores, props.nodeVCores);
  if (
    news.nodeStorageQuotaInMb !== undefined &&
    news.nodeStorageQuotaInMb > (props.nodeStorageQuotaInMb ?? 0)
  ) {
    properties.nodeStorageQuotaInMb = news.nodeStorageQuotaInMb;
  }
  set("enableHa", news.enableHa, props.enableHa);
  set(
    "enableShardsOnCoordinator",
    news.enableShardsOnCoordinator,
    props.enableShardsOnCoordinator,
  );
  set(
    "preferredPrimaryZone",
    news.preferredPrimaryZone,
    props.preferredPrimaryZone,
  );
  const window = news.maintenanceWindow;
  if (window !== undefined) {
    const current = props.maintenanceWindow ?? {};
    const drifted = (
      Object.keys(window) as (keyof ClusterMaintenanceWindow)[]
    ).some((key) => window[key] !== undefined && window[key] !== current[key]);
    if (drifted) properties.maintenanceWindow = { ...current, ...window };
  }

  return {
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    tags: tagsDiffer(observed.tags, tags) ? tags : undefined,
  };
};

const hasDelta = (delta: UpdateDelta) =>
  delta.properties !== undefined || delta.tags !== undefined;

/** Ready once provisioning succeeded and the cluster settled. */
const clusterStateOf = (cluster: ObservedCluster) => {
  const provisioning = cluster.properties?.provisioningState;
  if (provisioning === "Failed" || provisioning === "Canceled") {
    return provisioning;
  }
  const state = cluster.properties?.state;
  return provisioning === "Succeeded" &&
    (state === undefined || state === "Ready" || state === "Stopped")
    ? "Succeeded"
    : (provisioning ?? "InProgress");
};

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* postgresqlhsc
        .ListClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListClusters", page)),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const before: Partial<ClusterProps> = olds ?? {};
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location)) ||
        (news.postgresqlVersion !== undefined &&
          output.postgresqlVersion !== undefined &&
          Number(news.postgresqlVersion) < Number(output.postgresqlVersion)) ||
        (news.nodeCount ?? 0) < (before.nodeCount ?? 0) ||
        (news.coordinatorStorageQuotaInMb ?? 0) <
          (before.coordinatorStorageQuotaInMb ?? 0) ||
        (news.nodeStorageQuotaInMb ?? 0) < (before.nodeStorageQuotaInMb ?? 0) ||
        news.nodeEnablePublicIpAccess !== before.nodeEnablePublicIpAccess ||
        lower(news.sourceResourceId) !== lower(before.sourceResourceId) ||
        normalizeLocation(news.sourceLocation) !==
          normalizeLocation(before.sourceLocation) ||
        news.pointInTimeUTC !== before.pointInTimeUTC
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
      const observed = yield* getCluster({
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.administratorLoginPassword ?? olds?.administratorLoginPassword,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, COSMOS_POSTGRES_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const ref: ClusterRef = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `Cosmos DB for PostgreSQL cluster ${name}`;
      const get = getCluster(ref);
      const waitReady = waitForProvisioned(label, get, clusterStateOf, {
        interval: "20 seconds",
        times: 90,
      });

      // The password last applied through Alchemy; unknown for adoptions.
      const applied =
        output?.administratorLoginPassword ?? olds?.administratorLoginPassword;
      let password = news.administratorLoginPassword ?? applied;
      let passwordPending =
        news.administratorLoginPassword !== undefined &&
        reveal(news.administratorLoginPassword) !== reveal(applied);

      // Observe.
      const observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        password ??= yield* generatePassword;
        yield* postgresqlhsc
          .CreateCluster({
            ...ref,
            location,
            tags,
            properties: {
              administratorLoginPassword: password,
              postgresqlVersion:
                news.postgresqlVersion ?? DEFAULTS.postgresqlVersion,
              citusVersion: news.citusVersion,
              coordinatorServerEdition:
                news.coordinatorServerEdition ??
                DEFAULTS.coordinatorServerEdition,
              coordinatorVCores:
                news.coordinatorVCores ?? DEFAULTS.coordinatorVCores,
              coordinatorStorageQuotaInMb:
                news.coordinatorStorageQuotaInMb ??
                DEFAULTS.coordinatorStorageQuotaInMb,
              coordinatorEnablePublicIpAccess:
                news.coordinatorEnablePublicIpAccess ??
                DEFAULTS.coordinatorEnablePublicIpAccess,
              nodeCount: news.nodeCount ?? DEFAULTS.nodeCount,
              nodeServerEdition: news.nodeServerEdition,
              nodeVCores: news.nodeVCores,
              nodeStorageQuotaInMb: news.nodeStorageQuotaInMb,
              nodeEnablePublicIpAccess: news.nodeEnablePublicIpAccess,
              enableHa: news.enableHa,
              enableShardsOnCoordinator: news.enableShardsOnCoordinator,
              preferredPrimaryZone: news.preferredPrimaryZone,
              maintenanceWindow: news.maintenanceWindow,
              sourceResourceId: news.sourceResourceId,
              sourceLocation: news.sourceLocation,
              pointInTimeUTC: news.pointInTimeUTC,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
        passwordPending = false;
      }

      // Sync every mutable aspect against observed state in one PATCH, then
      // wait until the cluster reflects it (the PATCH applies
      // asynchronously). Re-issue a bounded number of times if dropped.
      const syncOnce = Effect.gen(function* () {
        const current = yield* waitReady;
        const delta = clusterDelta(current, news, tags);
        if (!hasDelta(delta) && !passwordPending) return current;
        yield* Effect.logDebug(`${label}: applying ${JSON.stringify(delta)}`);
        yield* postgresqlhsc
          .UpdateCluster({
            ...ref,
            tags: delta.tags,
            properties: passwordPending
              ? {
                  ...delta.properties,
                  administratorLoginPassword: news.administratorLoginPassword,
                }
              : delta.properties,
          })
          .pipe(Effect.retry(whileClusterBusy));
        passwordPending = false;
        const last = yield* get.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("20 seconds"),
            times: 90,
            until: (cluster) =>
              cluster !== undefined &&
              clusterStateOf(cluster) === "Succeeded" &&
              !hasDelta(clusterDelta(cluster, news, tags)),
          }),
        );
        if (
          last === undefined ||
          clusterStateOf(last) !== "Succeeded" ||
          hasDelta(clusterDelta(last, news, tags))
        ) {
          return yield* new ProvisioningTimedOut({
            resource: label,
            state: last?.properties?.state,
            message: `${label} did not apply the update (last state: ${last?.properties?.state ?? "not found"})`,
          });
        }
        return last;
      });
      const final = yield* syncOnce.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningTimedOut",
          times: 1,
        }),
      );

      return toAttrs(resourceGroup, name, final, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ClusterRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        clusterName: output.clusterName,
      };
      yield* ignoreNotFound(
        postgresqlhsc.DeleteCluster(ref).pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB for PostgreSQL cluster ${output.clusterName}`,
        getCluster(ref),
        { interval: "15 seconds", times: 80 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
