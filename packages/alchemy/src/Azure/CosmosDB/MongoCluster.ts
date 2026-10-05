import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import * as crypto from "node:crypto";
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
  getMongoCluster,
  type MongoClusterRef,
  normalizeMongoLocation,
  whileMongoClusterBusy,
} from "./MongoShared.ts";

export type MongoClusterAuthMode = "NativeAuth" | "MicrosoftEntraID";

export interface MongoClusterIdentity {
  /** Managed identity type of the cluster. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of the user-assigned identities to attach. */
  userAssignedIdentityIds?: string[];
}

export interface MongoClusterCustomerManagedKey {
  /** Key Vault key URL used as the key encryption key. */
  keyEncryptionKeyUrl: string;
  /** ARM ID of the user-assigned identity that can read the key. */
  userAssignedIdentityResourceId: string;
}

export interface MongoClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 3-40 lowercase letters, digits, and hyphens, globally
   * unique (it is the DNS label of the connection string). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the cluster.
   */
  name?: string;
  /**
   * Azure region of the cluster. Changing it replaces the cluster.
   * @default the provider's default location
   */
  location?: string;
  /**
   * How the cluster is created. `PointInTimeRestore` needs
   * `restoreParameters`; `GeoReplica` / `Replica` need `replicaParameters`.
   * Changing it replaces the cluster.
   * @default "Default"
   */
  createMode?: "Default" | "PointInTimeRestore" | "GeoReplica" | "Replica";
  /** Source cluster and point in time for `createMode: "PointInTimeRestore"`. Changing it replaces the cluster. */
  restoreParameters?: {
    /** UTC point in time to restore to (ISO 8601). */
    pointInTimeUTC?: string;
    /** ARM ID of the cluster to restore from. */
    sourceResourceId?: string;
  };
  /** Source cluster for `createMode: "GeoReplica"` / `"Replica"`. Changing it replaces the cluster. */
  replicaParameters?: {
    /** ARM ID of the replication source cluster. */
    sourceResourceId: string;
    /** Location of the source cluster. */
    sourceLocation: string;
  };
  /**
   * Native (SCRAM) administrator user name. Changing it replaces the
   * cluster.
   * @default "alchemyadmin"
   */
  administratorUserName?: string;
  /**
   * Native administrator password (8-256 characters). If omitted, a random
   * password is generated on create and exposed as an attribute. Changing it
   * updates the cluster in place.
   */
  administratorPassword?: Redacted.Redacted<string>;
  /**
   * MongoDB server version, e.g. `"7.0"` or `"8.0"`. Can only be upgraded in
   * place; a downgrade replaces the cluster.
   * @default the latest version Azure offers
   */
  serverVersion?: string;
  /**
   * Compute tier, e.g. `"Free"` (one per subscription, 32 GiB, no SLA),
   * `"M10"`, `"M30"`. Scaling between paid tiers and from `Free` to a paid
   * tier happens in place.
   * @default "M10"
   */
  computeTier?: string;
  /**
   * Disk size per shard in GiB. Can only grow in place; a smaller value
   * replaces the cluster.
   * @default 32
   */
  storageSizeGb?: number;
  /**
   * Disk type. Changing it replaces the cluster.
   * @default "PremiumSSD"
   */
  storageType?: "PremiumSSD" | "PremiumSSDv2";
  /**
   * Number of shards. Changing it replaces the cluster.
   * @default 1
   */
  shardCount?: number;
  /**
   * High availability mode. Not available on the `Free`, `M10`, and `M20`
   * tiers.
   * @default "Disabled"
   */
  highAvailability?: "Disabled" | "SameZone" | "ZoneRedundantPreferred";
  /**
   * Whether the public endpoint accepts connections (subject to firewall
   * rules).
   * @default "Enabled" (Azure's default)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** `AzureCosmosDB` lets the Azure Cosmos DB service bypass network restrictions. */
  networkBypassMode?: "None" | "AzureCosmosDB";
  /** Whether the Mongo Data API is enabled. */
  dataApi?: "Enabled" | "Disabled";
  /** Preview features to enable, e.g. `["GeoReplicas"]`. */
  previewFeatures?: "GeoReplicas"[];
  /**
   * Allowed data-plane authentication modes. Add `MicrosoftEntraID` to grant
   * Entra principals access with {@link MongoClusterUser}.
   * @default ["NativeAuth"]
   */
  authModes?: MongoClusterAuthMode[];
  /** Managed identity of the cluster (needed for customer-managed keys). */
  identity?: MongoClusterIdentity;
  /**
   * Customer-managed key encryption. Enabling it replaces the cluster; the
   * key URL can then be rotated in place.
   */
  customerManagedKey?: MongoClusterCustomerManagedKey;
  /** Tags applied to the cluster. */
  tags?: Record<string, string>;
}

export interface MongoCluster extends Resource<
  "Azure.CosmosDB.MongoCluster",
  MongoClusterProps,
  {
    /** Name of the cluster. */
    mongoClusterName: string;
    /** ARM resource ID of the cluster. */
    mongoClusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster (lowercase, no spaces, e.g. `eastus`). */
    location: string;
    /** MongoDB server version. */
    serverVersion: string | undefined;
    /** Compute tier. */
    computeTier: string | undefined;
    /** Disk size per shard in GiB. */
    storageSizeGb: number | undefined;
    /** Number of shards. */
    shardCount: number | undefined;
    /** High availability mode. */
    highAvailability: string | undefined;
    /** Whether the public endpoint is enabled. */
    publicNetworkAccess: string | undefined;
    /** Whether the Mongo Data API is enabled. */
    dataApi: string | undefined;
    /** Allowed data-plane authentication modes. */
    authModes: string[];
    /** Cluster status (`Ready`, `Updating`, `Stopped`, ...). */
    clusterStatus: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Infrastructure version the cluster runs on. */
    infrastructureVersion: string | undefined;
    /** Replication role (`Primary`, `GeoAsyncReplica`, ...). */
    replicationRole: string | undefined;
    /** Earliest point in time the cluster can be restored to. */
    earliestRestoreTime: string | undefined;
    /** Host name of the cluster (`<name>.global.mongocluster.cosmos.azure.com`). */
    host: string | undefined;
    /** Native administrator user name. */
    administratorUserName: string | undefined;
    /**
     * Administrator password last applied by Alchemy (given or generated).
     * `undefined` for adopted clusters whose password is unknown.
     */
    administratorPassword: Redacted.Redacted<string> | undefined;
    /**
     * `mongodb+srv://` connection string. Carries the administrator
     * credentials when the password is known; otherwise Azure's template
     * with `<user>`/`<password>` placeholders.
     */
    connectionString: Redacted.Redacted<string> | undefined;
    /** Principal ID of the system-assigned identity, when enabled. */
    identityPrincipalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Cosmos DB for MongoDB (vCore) cluster: a MongoDB-compatible
 * cluster with a `mongodb+srv://` endpoint. Add
 * {@link MongoClusterFirewallRule}s to open the public endpoint to client
 * IPs, and {@link MongoClusterUser}s to grant Entra principals access.
 *
 * The `Free` tier costs nothing (one per subscription, 32 GiB, limited
 * regions); `M10` is the cheapest paid tier. Provisioning takes about
 * 5-15 minutes.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/vcore/
 *
 * ### Creating a Cluster
 * **Example:** Free-tier cluster with a generated administrator password
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const cluster = yield* Azure.CosmosDB.MongoCluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   computeTier: "Free",
 * });
 * // cluster.connectionString is a Redacted mongodb+srv:// URL
 * ```
 *
 * **Example:** Paid cluster with an explicit password and version
 * ```typescript
 * const cluster = yield* Azure.CosmosDB.MongoCluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   computeTier: "M30",
 *   storageSizeGb: 128,
 *   serverVersion: "8.0",
 *   highAvailability: "ZoneRedundantPreferred",
 *   administratorPassword: yield* Config.redacted("MONGO_PASSWORD"),
 * });
 * ```
 *
 * ### Entra ID Authentication
 * **Example:** Allow Entra ID principals alongside native users
 * ```typescript
 * const cluster = yield* Azure.CosmosDB.MongoCluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   authModes: ["NativeAuth", "MicrosoftEntraID"],
 * });
 * ```
 *
 * ### Networking
 * **Example:** Private-only cluster
 * ```typescript
 * const cluster = yield* Azure.CosmosDB.MongoCluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const MongoCluster = Resource<MongoCluster>(
  "Azure.CosmosDB.MongoCluster",
);

const DEFAULT_ADMIN = "alchemyadmin";
const DEFAULT_TIER = "M10";
const DEFAULT_STORAGE_GB = 32;

type ObservedCluster =
  | mongocluster.GetMongoClusterResponse
  | mongocluster.MongoCluster;

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

/** Random password satisfying Azure's complexity rules (all four classes). */
const generatePassword = Effect.sync(() =>
  Redacted.make(
    `Aa1-${Buffer.from(crypto.randomBytes(24)).toString("base64url")}`,
  ),
);

const reveal = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

const sortedKey = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort().join(",");

const usesNativeAuth = (props: MongoClusterProps) =>
  (props.authModes ?? ["NativeAuth"]).includes("NativeAuth");

const isDefaultCreate = (props: MongoClusterProps) =>
  (props.createMode ?? "Default") === "Default";

const hostOf = (template: string | undefined) =>
  template?.match(/@([^/?]+)/)?.[1];

/**
 * Azure's connection string is a template
 * (`mongodb+srv://<user>:<password>@host/?...`); fill in the credentials
 * when they are known.
 */
const connectionStringOf = (
  template: string | undefined,
  user: string | undefined,
  password: Redacted.Redacted<string> | undefined,
) => {
  if (!template) return undefined;
  if (user === undefined || password === undefined) {
    return Redacted.make(template);
  }
  const host = hostOf(template);
  const query = template.split("?")[1];
  return Redacted.make(
    `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(
      Redacted.value(password),
    )}@${host}/${query ? `?${query}` : ""}`,
  );
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
  password: Redacted.Redacted<string> | undefined,
): MongoCluster["Attributes"] => {
  const props = cluster.properties ?? {};
  const template = reveal(props.connectionString);
  const user = props.administrator?.userName;
  return {
    mongoClusterName: name,
    mongoClusterId: cluster.id ?? "",
    resourceGroup,
    location: normalizeMongoLocation(cluster.location),
    serverVersion: props.serverVersion,
    computeTier: props.compute?.tier,
    storageSizeGb: props.storage?.sizeGb,
    shardCount: props.sharding?.shardCount,
    highAvailability: props.highAvailability?.targetMode,
    publicNetworkAccess: props.publicNetworkAccess,
    dataApi: props.dataApi?.mode,
    authModes: [...(props.authConfig?.allowedModes ?? [])],
    clusterStatus: props.clusterStatus,
    provisioningState: props.provisioningState,
    infrastructureVersion: props.infrastructureVersion,
    replicationRole: props.replica?.role,
    earliestRestoreTime: props.backup?.earliestRestoreTime,
    host: hostOf(template),
    administratorUserName: user,
    administratorPassword: password,
    connectionString: connectionStringOf(template, user, password),
    identityPrincipalId: cluster.identity?.principalId,
    tags: userTags(cluster.tags),
  };
};

const identityInput = (
  identity: MongoClusterIdentity,
): mongocluster.MongoClustersCreateOrUpdateRequestIdentity => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentityIds?.length
    ? Object.fromEntries(identity.userAssignedIdentityIds.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: ObservedCluster["identity"],
  desired: MongoClusterIdentity,
) =>
  (observed?.type ?? "None") !== desired.type ||
  sortedKey(
    Object.keys(observed?.userAssignedIdentities ?? {}).map((id) =>
      id.toLowerCase(),
    ),
  ) !==
    sortedKey(
      (desired.userAssignedIdentityIds ?? []).map((id) => id.toLowerCase()),
    );

const encryptionInput = (
  key: MongoClusterCustomerManagedKey,
): mongocluster.EncryptionProperties => ({
  customerManagedKeyEncryption: {
    keyEncryptionKeyUrl: key.keyEncryptionKeyUrl,
    keyEncryptionKeyIdentity: {
      identityType: "UserAssignedIdentity",
      userAssignedIdentityResourceId: key.userAssignedIdentityResourceId,
    },
  },
});

type ClusterPatch = Omit<
  mongocluster.UpdateMongoClusterRequest,
  "subscriptionId" | "resourceGroupName" | "mongoClusterName"
>;

/**
 * The PATCH body that moves `observed` to the desired state, or `undefined`
 * when the cluster already matches. The password is not observable and is
 * handled by the caller.
 */
const clusterDelta = (
  observed: ObservedCluster,
  news: MongoClusterProps,
  tags: Record<string, string>,
): ClusterPatch | undefined => {
  const props = observed.properties ?? {};
  const properties: mongocluster.MongoClusterUpdatePropertiesInput = {};

  if (
    news.serverVersion !== undefined &&
    Number(news.serverVersion) > Number(props.serverVersion ?? 0)
  ) {
    properties.serverVersion = news.serverVersion;
  }
  // Replicas and restores inherit compute and storage from their source
  // unless set explicitly.
  const tier =
    news.computeTier ?? (isDefaultCreate(news) ? DEFAULT_TIER : undefined);
  if (
    tier !== undefined &&
    tier.toLowerCase() !== (props.compute?.tier ?? "").toLowerCase()
  ) {
    properties.compute = { tier };
  }
  const sizeGb =
    news.storageSizeGb ??
    (isDefaultCreate(news) ? DEFAULT_STORAGE_GB : undefined);
  if (sizeGb !== undefined && sizeGb > (props.storage?.sizeGb ?? 0)) {
    properties.storage = { sizeGb };
  }
  if (
    news.highAvailability !== undefined &&
    news.highAvailability !== props.highAvailability?.targetMode
  ) {
    properties.highAvailability = { targetMode: news.highAvailability };
  }
  if (
    news.publicNetworkAccess !== undefined &&
    news.publicNetworkAccess !== props.publicNetworkAccess
  ) {
    properties.publicNetworkAccess = news.publicNetworkAccess;
  }
  if (
    news.networkBypassMode !== undefined &&
    news.networkBypassMode !== (props.networkBypassMode ?? "None")
  ) {
    properties.networkBypassMode = news.networkBypassMode;
  }
  if (
    news.dataApi !== undefined &&
    news.dataApi !== (props.dataApi?.mode ?? "Disabled")
  ) {
    properties.dataApi = { mode: news.dataApi };
  }
  if (
    news.previewFeatures !== undefined &&
    sortedKey(news.previewFeatures) !== sortedKey(props.previewFeatures)
  ) {
    properties.previewFeatures = news.previewFeatures;
  }
  if (
    news.authModes !== undefined &&
    sortedKey(news.authModes) !== sortedKey(props.authConfig?.allowedModes)
  ) {
    properties.authConfig = { allowedModes: news.authModes };
  }
  if (
    news.customerManagedKey !== undefined &&
    news.customerManagedKey.keyEncryptionKeyUrl !==
      props.encryption?.customerManagedKeyEncryption?.keyEncryptionKeyUrl
  ) {
    properties.encryption = encryptionInput(news.customerManagedKey);
  }

  const patch: ClusterPatch = {
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    identity:
      news.identity !== undefined &&
      identityDiffers(observed.identity, news.identity)
        ? identityInput(news.identity)
        : undefined,
    tags: tagsDiffer(observed.tags, tags) ? tags : undefined,
  };
  return Object.values(patch).some((value) => value !== undefined)
    ? patch
    : undefined;
};

/** Ready once provisioning succeeded and the cluster is not transitioning. */
const clusterStateOf = (cluster: ObservedCluster) => {
  const props = cluster.properties ?? {};
  const state = props.provisioningState;
  if (state !== undefined && state !== "Succeeded") return state;
  const status = props.clusterStatus;
  return status === undefined || status === "Ready" || status === "Stopped"
    ? "Succeeded"
    : status;
};

const WAIT = { interval: "20 seconds", times: 60 } as const;

export const MongoClusterProvider = () =>
  Provider.succeed(MongoCluster, {
    stables: [
      "mongoClusterName",
      "mongoClusterId",
      "resourceGroup",
      "location",
      "host",
      "administratorUserName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mongocluster
        .ListMongoClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListMongoClusters", page),
          ),
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
      const before: Partial<MongoClusterProps> = olds ?? {};
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined && news.name !== output.mongoClusterName) ||
        (news.location !== undefined &&
          normalizeMongoLocation(news.location) !== output.location) ||
        (news.createMode ?? "Default") !== (before.createMode ?? "Default") ||
        JSON.stringify(news.restoreParameters) !==
          JSON.stringify(before.restoreParameters) ||
        JSON.stringify(news.replicaParameters) !==
          JSON.stringify(before.replicaParameters) ||
        (news.administratorUserName ?? DEFAULT_ADMIN) !==
          (before.administratorUserName ?? DEFAULT_ADMIN) ||
        (news.storageType ?? "PremiumSSD") !==
          (before.storageType ?? "PremiumSSD") ||
        (news.shardCount ?? 1) !== (before.shardCount ?? 1) ||
        (news.storageSizeGb ?? DEFAULT_STORAGE_GB) <
          (output.storageSizeGb ?? 0) ||
        (news.serverVersion !== undefined &&
          output.serverVersion !== undefined &&
          Number(news.serverVersion) < Number(output.serverVersion)) ||
        ((news.computeTier ?? DEFAULT_TIER).toLowerCase() === "free" &&
          (output.computeTier ?? "free").toLowerCase() !== "free") ||
        (news.customerManagedKey === undefined) !==
          (before.customerManagedKey === undefined)
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
        output?.mongoClusterName ??
        olds?.name ??
        (yield* createClusterName(id));
      const observed = yield* getMongoCluster({
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.administratorPassword ?? olds?.administratorPassword,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.mongoClusterName ?? (yield* createClusterName(id));
      const location = normalizeMongoLocation(
        news.location ?? output?.location ?? env.location,
      );
      const tags = yield* desiredTags(id, news.tags);
      const ref: MongoClusterRef = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: name,
      };
      const label = `Mongo cluster ${name}`;
      const get = getMongoCluster(ref);

      // The password last applied through Alchemy; unknown for adoptions.
      const applied =
        output?.administratorPassword ?? olds?.administratorPassword;
      let password = news.administratorPassword ?? applied;
      let passwordPending =
        news.administratorPassword !== undefined &&
        reveal(news.administratorPassword) !== reveal(applied);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (~5-15 minutes).
      if (observed === undefined) {
        const native = usesNativeAuth(news) && isDefaultCreate(news);
        if (native && password === undefined) {
          password = yield* generatePassword;
        }
        yield* mongocluster
          .MongoClustersCreateOrUpdate({
            ...ref,
            location,
            tags,
            identity: news.identity ? identityInput(news.identity) : undefined,
            properties: {
              createMode: news.createMode,
              restoreParameters: news.restoreParameters,
              replicaParameters: news.replicaParameters,
              administrator: native
                ? {
                    userName: news.administratorUserName ?? DEFAULT_ADMIN,
                    password,
                  }
                : undefined,
              serverVersion: news.serverVersion,
              compute: isDefaultCreate(news)
                ? { tier: news.computeTier ?? DEFAULT_TIER }
                : undefined,
              storage: isDefaultCreate(news)
                ? {
                    sizeGb: news.storageSizeGb ?? DEFAULT_STORAGE_GB,
                    type: news.storageType,
                  }
                : undefined,
              sharding: isDefaultCreate(news)
                ? { shardCount: news.shardCount ?? 1 }
                : undefined,
              // Required on create.
              highAvailability: {
                targetMode: news.highAvailability ?? "Disabled",
              },
              publicNetworkAccess: news.publicNetworkAccess,
              networkBypassMode: news.networkBypassMode,
              dataApi: news.dataApi ? { mode: news.dataApi } : undefined,
              previewFeatures: news.previewFeatures,
              authConfig: news.authModes
                ? { allowedModes: news.authModes }
                : undefined,
              encryption: news.customerManagedKey
                ? encryptionInput(news.customerManagedKey)
                : undefined,
            },
          })
          .pipe(Effect.retry(whileMongoClusterBusy));
        passwordPending = false;
      }
      observed = yield* waitForProvisioned(label, get, clusterStateOf, WAIT);

      // Sync every mutable aspect against observed state in one PATCH, then
      // wait until the cluster is settled and reflects it.
      const delta = clusterDelta(observed, news, tags);
      if (delta !== undefined || passwordPending) {
        yield* Effect.logDebug(`${label}: applying ${JSON.stringify(delta)}`);
        yield* mongocluster
          .UpdateMongoCluster({
            ...ref,
            ...delta,
            properties: passwordPending
              ? {
                  ...delta?.properties,
                  // Azure requires the login alongside a new password.
                  administrator: {
                    userName:
                      observed.properties?.administrator?.userName ??
                      news.administratorUserName ??
                      DEFAULT_ADMIN,
                    password: news.administratorPassword,
                  },
                }
              : delta?.properties,
          })
          .pipe(Effect.retry(whileMongoClusterBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (cluster) =>
            clusterDelta(cluster, news, tags) === undefined
              ? clusterStateOf(cluster)
              : "Updating",
          WAIT,
        );
      }

      return toAttrs(resourceGroup, name, observed, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: MongoClusterRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        mongoClusterName: output.mongoClusterName,
      };
      yield* ignoreNotFound(
        mongocluster
          .DeleteMongoCluster(ref)
          .pipe(Effect.retry(whileMongoClusterBusy)),
      );
      yield* waitUntilGone(
        `Mongo cluster ${output.mongoClusterName}`,
        getMongoCluster(ref),
        WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
