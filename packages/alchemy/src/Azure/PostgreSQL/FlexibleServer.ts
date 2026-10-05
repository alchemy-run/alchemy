import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as crypto from "node:crypto";
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
  ProvisioningFailed,
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
  getServer,
  POSTGRES_NAMESPACE,
  type ServerRef,
  waitServerSettled,
  whileServerBusy,
} from "./common.ts";

export type PostgresMajorVersion = postgresql.PostgresMajorVersion;
export type PostgresSkuTier = postgresql.SkuTier;
export type PostgresStorageTier = postgresql.AzureManagedDiskPerformanceTier;

export interface FlexibleServerSku {
  /** Compute size, e.g. `Standard_B1ms`, `Standard_D2ds_v5`. */
  name: string;
  /** Compute tier matching the size. */
  tier: PostgresSkuTier;
}

export interface FlexibleServerStorage {
  /**
   * Storage size in GiB. Can only grow in place; asking for less than the
   * previously requested size replaces the server.
   * @default 32
   */
  storageSizeGB?: number;
  /** Grow storage automatically when free space runs low. */
  autoGrow?: "Enabled" | "Disabled";
  /** Performance tier of the managed disk (`P4` … `P80`). */
  tier?: PostgresStorageTier;
  /**
   * Disk type. Changing it replaces the server.
   * @default "Premium_LRS"
   */
  type?: "Premium_LRS" | "PremiumV2_LRS";
  /** Provisioned IOPS (`PremiumV2_LRS` only). */
  iops?: number;
  /** Provisioned throughput in MB/s (`PremiumV2_LRS` only). */
  throughput?: number;
}

export interface FlexibleServerBackup {
  /**
   * Days to retain automatic backups (7-35).
   * @default 7
   */
  backupRetentionDays?: number;
  /**
   * Store backups in the paired region. Changing it replaces the server.
   * @default "Disabled"
   */
  geoRedundantBackup?: "Enabled" | "Disabled";
}

export interface FlexibleServerNetwork {
  /**
   * Whether the public endpoint accepts traffic (public-access servers only;
   * firewall rules still apply).
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Subnet delegated to `Microsoft.DBforPostgreSQL/flexibleServers` for
   * VNet integration. Changing it replaces the server.
   */
  delegatedSubnetResourceId?: string;
  /**
   * Private DNS zone used with VNet integration. Changing it replaces the
   * server.
   */
  privateDnsZoneArmResourceId?: string;
}

export interface FlexibleServerHighAvailability {
  /** High availability mode. Not available on the Burstable tier. */
  mode: "Disabled" | "ZoneRedundant" | "SameZone";
  /** Availability zone of the standby server. */
  standbyAvailabilityZone?: string;
}

export interface FlexibleServerMaintenanceWindow {
  /** `Enabled` to use the custom window below, `Disabled` for system-managed. */
  customWindow?: "Enabled" | "Disabled";
  /** Start hour (UTC, 0-23). */
  startHour?: number;
  /** Start minute (0-59). */
  startMinute?: number;
  /** Day of the week (0 = Sunday). */
  dayOfWeek?: number;
}

export interface FlexibleServerAuthConfig {
  /** Allow Microsoft Entra authentication. */
  activeDirectoryAuth?: "Enabled" | "Disabled";
  /** Allow password authentication. */
  passwordAuth?: "Enabled" | "Disabled";
  /**
   * Tenant for Microsoft Entra authentication.
   * @default the deploying subscription's tenant when Entra auth is enabled
   */
  tenantId?: string;
}

export interface FlexibleServerDataEncryption {
  /** Encryption type. Changing it replaces the server. */
  type: "SystemManaged" | "AzureKeyVault";
  /** Key Vault key URI for customer-managed keys. */
  primaryKeyURI?: string;
  /** User-assigned identity that can read the primary key. */
  primaryUserAssignedIdentityId?: string;
  /** Key Vault key URI for geo-redundant backups. */
  geoBackupKeyURI?: string;
  /** User-assigned identity that can read the geo-backup key. */
  geoBackupUserAssignedIdentityId?: string;
}

export interface FlexibleServerIdentity {
  /** Identity type. */
  type:
    | "None"
    | "UserAssigned"
    | "SystemAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentityIds?: string[];
}

export interface FlexibleServerProps {
  /** Resource group the server is created in. Changing it replaces the server. */
  resourceGroup: string;
  /**
   * Globally unique server name (it becomes the DNS label
   * `{name}.postgres.database.azure.com`): 3-63 lowercase letters, digits,
   * and hyphens. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the server.
   */
  name?: string;
  /**
   * Azure location of the server. Changing it replaces the server.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * PostgreSQL major version. Upgrades happen in place; a downgrade
   * replaces the server.
   * @default "16"
   */
  version?: PostgresMajorVersion;
  /**
   * Compute size and tier.
   * @default { name: "Standard_B1ms", tier: "Burstable" }
   */
  sku?: FlexibleServerSku;
  /**
   * Login of the password-based administrator. Cannot change after
   * creation: changing it replaces the server. Must not be `admin`,
   * `administrator`, `root`, `guest`, `public`, or start with `pg_`.
   * @default "alchemyadmin"
   */
  administratorLogin?: string;
  /**
   * Administrator password (8-128 characters from three of: upper, lower,
   * digits, symbols). Changing it updates the server in place. If omitted,
   * a random password is generated on create and exposed as an attribute.
   */
  administratorLoginPassword?: Redacted.Redacted<string>;
  /** Storage configuration. */
  storage?: FlexibleServerStorage;
  /** Automatic backup configuration. */
  backup?: FlexibleServerBackup;
  /** Network configuration. Defaults to a public-access server. */
  network?: FlexibleServerNetwork;
  /** High availability configuration (General Purpose / Memory Optimized only). */
  highAvailability?: FlexibleServerHighAvailability;
  /**
   * Availability zone of the primary server, set at creation. Changing it
   * replaces the server.
   */
  availabilityZone?: string;
  /** Maintenance window. */
  maintenanceWindow?: FlexibleServerMaintenanceWindow;
  /**
   * Authentication methods.
   * @default password authentication only
   */
  authConfig?: FlexibleServerAuthConfig;
  /** Data encryption (system-managed or customer-managed keys). */
  dataEncryption?: FlexibleServerDataEncryption;
  /** Managed identities of the server. */
  identity?: FlexibleServerIdentity;
  /**
   * How the server is created. `Replica` creates a read replica of
   * `sourceServerResourceId`; `PointInTimeRestore`/`GeoRestore` restore
   * it. Changing it replaces the server.
   * @default "Create"
   */
  createMode?: "Create" | "Replica" | "PointInTimeRestore" | "GeoRestore";
  /**
   * Source server for `Replica`, `PointInTimeRestore`, and `GeoRestore`.
   * Changing it replaces the server.
   */
  sourceServerResourceId?: string;
  /**
   * Restore point (ISO 8601) for `PointInTimeRestore`/`GeoRestore`.
   * Changing it replaces the server.
   */
  pointInTimeUTC?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface FlexibleServer extends Resource<
  "Azure.PostgreSQL.FlexibleServer",
  FlexibleServerProps,
  {
    /** Name of the server. */
    serverName: string;
    /** ARM resource ID of the server. */
    serverId: string;
    /** Resource group that holds the server. */
    resourceGroup: string;
    /** Location of the server. */
    location: string;
    /** Host name, e.g. `{name}.postgres.database.azure.com`. */
    fullyQualifiedDomainName: string;
    /** Server state (`Ready`, `Stopped`, …). */
    state: string;
    /** PostgreSQL major version. */
    version: string;
    /** PostgreSQL minor version. */
    minorVersion: string | undefined;
    /** Compute size. */
    skuName: string;
    /** Compute tier. */
    skuTier: string;
    /** Availability zone of the primary server. */
    availabilityZone: string | undefined;
    /** Role in a replication set (`None`, `Primary`, `AsyncReplica`, …). */
    replicationRole: string | undefined;
    /** Login of the password-based administrator. */
    administratorLogin: string | undefined;
    /**
     * Administrator password last applied by Alchemy (the given or the
     * generated one). `undefined` for adopted servers whose password is
     * unknown.
     */
    administratorLoginPassword: Redacted.Redacted<string> | undefined;
    /**
     * `postgresql://` connection string for the administrator and the
     * `postgres` database, with `sslmode=require`.
     */
    connectionString: Redacted.Redacted<string> | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    identityPrincipalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Database for PostgreSQL flexible server.
 *
 * Servers default to the cheapest configuration — Burstable
 * `Standard_B1ms`, 32 GiB Premium SSD, PostgreSQL 16, public access with
 * no firewall rules (add `PostgreSQL.FirewallRule`s to let clients in).
 * Creation takes several minutes.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/overview
 *
 * ### Creating a Server
 * **Example:** Burstable server with a generated password
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const server = yield* Azure.PostgreSQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // server.connectionString is a Redacted postgresql:// URL
 * ```
 *
 * **Example:** General Purpose server with longer backup retention
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 *   version: "17",
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 *   storage: { storageSizeGB: 128, autoGrow: "Enabled" },
 *   backup: { backupRetentionDays: 14 },
 *   administratorLoginPassword: yield* Config.redacted("PG_PASSWORD"),
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Enable Microsoft Entra authentication
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 *   authConfig: { activeDirectoryAuth: "Enabled", passwordAuth: "Enabled" },
 * });
 * ```
 *
 * ### Read Replicas
 * **Example:** Replica of an existing server
 * ```typescript
 * const replica = yield* Azure.PostgreSQL.FlexibleServer("replica", {
 *   resourceGroup: group.resourceGroupName,
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 * });
 * ```
 *
 * @resource
 */
export const FlexibleServer = Resource<FlexibleServer>(
  "Azure.PostgreSQL.FlexibleServer",
);

type ObservedServer = postgresql.GetServerResponse;

const DEFAULT_SKU: FlexibleServerSku = {
  name: "Standard_B1ms",
  tier: "Burstable",
};
const DEFAULT_LOGIN = "alchemyadmin";

const createServerName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
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

const lower = (value: string | undefined) => value?.toLowerCase();

/** ARM reports PostgreSQL server locations by display name (`Central US`). */
const normalizeLocation = (value: string | undefined) =>
  value?.replace(/\s+/g, "").toLowerCase();

const isPasswordCreate = (props: FlexibleServerProps) =>
  (props.createMode ?? "Create") === "Create";

const connectionStringOf = (
  login: string | undefined,
  password: Redacted.Redacted<string> | undefined,
  fqdn: string | undefined,
) =>
  login !== undefined && password !== undefined && fqdn
    ? Redacted.make(
        `postgresql://${encodeURIComponent(login)}:${encodeURIComponent(
          Redacted.value(password),
        )}@${fqdn}:5432/postgres?sslmode=require`,
      )
    : undefined;

const toAttrs = (
  resourceGroup: string,
  name: string,
  server: ObservedServer,
  password: Redacted.Redacted<string> | undefined,
): FlexibleServer["Attributes"] => {
  const props = server.properties ?? {};
  return {
    serverName: name,
    serverId: server.id ?? "",
    resourceGroup,
    location: server.location,
    fullyQualifiedDomainName: props.fullyQualifiedDomainName ?? "",
    state: props.state ?? "",
    version: props.version ?? "",
    minorVersion: props.minorVersion,
    skuName: server.sku?.name ?? "",
    skuTier: server.sku?.tier ?? "",
    availabilityZone: props.availabilityZone || undefined,
    replicationRole: props.replicationRole,
    administratorLogin: props.administratorLogin,
    administratorLoginPassword: password,
    connectionString: connectionStringOf(
      props.administratorLogin,
      password,
      props.fullyQualifiedDomainName,
    ),
    identityPrincipalId: server.identity?.principalId,
    tags: userTags(server.tags),
  };
};

const identityInput = (
  identity: FlexibleServerIdentity,
): postgresql.UserAssignedIdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentityIds?.length
    ? Object.fromEntries(identity.userAssignedIdentityIds.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: postgresql.UserAssignedIdentity | undefined,
  desired: FlexibleServerIdentity,
) => {
  if ((observed?.type ?? "None") !== desired.type) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentityIds ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

/** Fields of `desired` whose values differ from `observed`. */
const changedFields = <T extends object>(
  observed: Partial<T> | undefined,
  desired: Partial<T> | undefined,
): Partial<T> | undefined => {
  if (desired === undefined) return undefined;
  const changed: Partial<T> = {};
  for (const key of Object.keys(desired) as (keyof T)[]) {
    const value = desired[key];
    if (value !== undefined && observed?.[key] !== value) changed[key] = value;
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
};

/**
 * The PATCH body that moves `observed` to the desired state, or `undefined`
 * when the server already matches. The password is not observable and is
 * handled by the caller.
 */
const serverDelta = (
  observed: ObservedServer,
  news: FlexibleServerProps,
  sku: FlexibleServerSku,
  tags: Record<string, string>,
  tenantId: string,
): Omit<
  postgresql.UpdateServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> => {
  const props = observed.properties ?? {};
  const properties: postgresql.ServerPropertiesForPatchInput = {};

  if (
    news.version !== undefined &&
    Number(news.version) > Number(props.version ?? 0)
  ) {
    properties.version = news.version;
    properties.createMode = "Update";
  }

  const storage = news.storage;
  if (storage !== undefined) {
    const changed: postgresql.Storage = {};
    if (
      storage.storageSizeGB !== undefined &&
      storage.storageSizeGB > (props.storage?.storageSizeGB ?? 0)
    ) {
      changed.storageSizeGB = storage.storageSizeGB;
    }
    Object.assign(
      changed,
      changedFields(props.storage, {
        autoGrow: storage.autoGrow,
        tier: storage.tier,
        iops: storage.iops,
        throughput: storage.throughput,
      }),
    );
    if (Object.keys(changed).length > 0) properties.storage = changed;
  }

  const retention = news.backup?.backupRetentionDays;
  if (
    retention !== undefined &&
    retention !== props.backup?.backupRetentionDays
  ) {
    properties.backup = { backupRetentionDays: retention };
  }

  if (news.highAvailability !== undefined) {
    const changed = changedFields(props.highAvailability, {
      mode: news.highAvailability.mode,
      standbyAvailabilityZone: news.highAvailability.standbyAvailabilityZone,
    });
    if (changed) properties.highAvailability = news.highAvailability;
  }

  if (
    news.maintenanceWindow !== undefined &&
    changedFields(props.maintenanceWindow, news.maintenanceWindow)
  ) {
    properties.maintenanceWindow = {
      ...props.maintenanceWindow,
      ...news.maintenanceWindow,
    };
  }

  const auth = desiredAuth(news, tenantId);
  if (auth !== undefined && changedFields(props.authConfig, auth)) {
    properties.authConfig = auth;
  }

  const publicAccess = news.network?.publicNetworkAccess;
  if (
    publicAccess !== undefined &&
    publicAccess !== props.network?.publicNetworkAccess
  ) {
    properties.network = { publicNetworkAccess: publicAccess };
  }

  const encryption = news.dataEncryption;
  if (encryption !== undefined) {
    const changed = changedFields(props.dataEncryption, {
      primaryKeyURI: encryption.primaryKeyURI,
      primaryUserAssignedIdentityId: encryption.primaryUserAssignedIdentityId,
      geoBackupKeyURI: encryption.geoBackupKeyURI,
      geoBackupUserAssignedIdentityId:
        encryption.geoBackupUserAssignedIdentityId,
    });
    if (changed) properties.dataEncryption = { ...encryption };
  }

  return {
    sku:
      observed.sku?.name !== sku.name || observed.sku?.tier !== sku.tier
        ? sku
        : undefined,
    identity:
      news.identity !== undefined &&
      identityDiffers(observed.identity, news.identity)
        ? identityInput(news.identity)
        : undefined,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    tags: tagsDiffer(observed.tags, tags) ? tags : undefined,
  };
};

const desiredAuth = (
  news: FlexibleServerProps,
  tenantId: string,
): FlexibleServerAuthConfig | undefined =>
  news.authConfig === undefined
    ? undefined
    : {
        ...news.authConfig,
        tenantId:
          news.authConfig.activeDirectoryAuth === "Enabled"
            ? (news.authConfig.tenantId ?? tenantId)
            : news.authConfig.tenantId,
      };

const hasDelta = (delta: ReturnType<typeof serverDelta>) =>
  Object.values(delta).some((value) => value !== undefined);

/** Ready once the server reports `Ready` (`Disabled` is terminal). */
const serverStateOf = (server: ObservedServer) => {
  const state = server.properties?.state;
  return state === "Ready"
    ? "Succeeded"
    : state === "Disabled"
      ? "Failed"
      : (state ?? "Provisioning");
};

const replicationRoleOf = (server: ObservedServer) =>
  server.properties?.replica?.role ?? server.properties?.replicationRole;

/**
 * A new replica first reports `Ready` with role `Primary` while it is still
 * being attached, and its source server stays `Updating` meanwhile; both
 * reject further operations (e.g. virtual endpoints) until then. Wait until
 * the replica is a `Ready` replica and its source has settled.
 */
const waitReplicaAttached = (
  label: string,
  ref: ServerRef,
  sourceServerResourceId: string | undefined,
) =>
  Effect.gen(function* () {
    const attached = yield* waitForProvisioned(
      label,
      getServer(ref),
      (server) => {
        const role = replicationRoleOf(server);
        return role === "Primary" || role === "None" || role === undefined
          ? "Provisioning"
          : serverStateOf(server);
      },
      { interval: "10 seconds", times: 90 },
    );
    const sourceGroup = resourceGroupOf(sourceServerResourceId);
    const sourceName = sourceServerResourceId?.split("/").pop();
    if (sourceGroup !== undefined && sourceName) {
      yield* waitServerSettled({
        subscriptionId: ref.subscriptionId,
        resourceGroupName: sourceGroup,
        serverName: sourceName,
      });
    }
    return attached;
  });

export const FlexibleServerProvider = () =>
  Provider.succeed(FlexibleServer, {
    stables: [
      "serverName",
      "serverId",
      "resourceGroup",
      "location",
      "fullyQualifiedDomainName",
      "administratorLogin",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* postgresql
        .ListServerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListServerBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((server) => {
        const group = resourceGroupOf(server.id);
        return hasAnyAlchemyTag(server.tags) &&
          group !== undefined &&
          server.name !== undefined
          ? [toAttrs(group, server.name, server, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const before: Partial<FlexibleServerProps> = olds ?? {};
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.serverName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location)) ||
        (news.version !== undefined &&
          output.version !== "" &&
          Number(news.version) < Number(output.version)) ||
        (news.administratorLogin ?? DEFAULT_LOGIN) !==
          (before.administratorLogin ?? DEFAULT_LOGIN) ||
        (news.createMode ?? "Create") !== (before.createMode ?? "Create") ||
        news.sourceServerResourceId !== before.sourceServerResourceId ||
        news.pointInTimeUTC !== before.pointInTimeUTC ||
        news.availabilityZone !== before.availabilityZone ||
        (news.storage?.type ?? "Premium_LRS") !==
          (before.storage?.type ?? "Premium_LRS") ||
        (news.storage?.storageSizeGB ?? 0) <
          (before.storage?.storageSizeGB ?? 0) ||
        (news.backup?.geoRedundantBackup ?? "Disabled") !==
          (before.backup?.geoRedundantBackup ?? "Disabled") ||
        lower(news.network?.delegatedSubnetResourceId) !==
          lower(before.network?.delegatedSubnetResourceId) ||
        lower(news.network?.privateDnsZoneArmResourceId) !==
          lower(before.network?.privateDnsZoneArmResourceId) ||
        (news.dataEncryption?.type ?? "SystemManaged") !==
          (before.dataEncryption?.type ?? "SystemManaged")
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
        output?.serverName ?? olds?.name ?? (yield* createServerName(id));
      const observed = yield* getServer({
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: name,
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
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.serverName ?? (yield* createServerName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? DEFAULT_SKU;
      const ref: ServerRef = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: name,
      };
      const label = `PostgreSQL flexible server ${name}`;
      const get = getServer(ref);
      const waitReady = waitForProvisioned(label, get, serverStateOf, {
        interval: "10 seconds",
        times: 90,
      });

      // The password last applied through Alchemy; unknown for adoptions.
      const applied =
        output?.administratorLoginPassword ?? olds?.administratorLoginPassword;
      let password = news.administratorLoginPassword ?? applied;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (202 + empty body).
      if (observed === undefined) {
        const passwordCreate = isPasswordCreate(news);
        if (passwordCreate && password === undefined) {
          password = yield* generatePassword;
        }
        yield* postgresql
          .ServersCreateOrUpdate({
            ...ref,
            location,
            tags,
            sku,
            identity: news.identity ? identityInput(news.identity) : undefined,
            properties: {
              createMode: news.createMode ?? "Create",
              administratorLogin: passwordCreate
                ? (news.administratorLogin ?? DEFAULT_LOGIN)
                : undefined,
              administratorLoginPassword: passwordCreate ? password : undefined,
              version: news.version ?? (passwordCreate ? "16" : undefined),
              storage: {
                ...news.storage,
                storageSizeGB: news.storage?.storageSizeGB ?? 32,
              },
              backup: news.backup,
              network: news.network,
              highAvailability: news.highAvailability,
              maintenanceWindow: news.maintenanceWindow,
              authConfig: desiredAuth(news, env.tenantId),
              dataEncryption: news.dataEncryption,
              availabilityZone: news.availabilityZone,
              sourceServerResourceId: news.sourceServerResourceId,
              pointInTimeUTC: news.pointInTimeUTC,
            },
          })
          .pipe(Effect.retry(whileServerBusy));
        observed = yield* waitReady;
      } else {
        const settled = yield* waitServerSettled(ref);
        // A stopped server rejects updates; start it to converge.
        if (settled?.properties?.state === "Stopped") {
          yield* postgresql
            .StartServer(ref)
            .pipe(Effect.retry(whileServerBusy));
        }

        // Sync every mutable aspect against observed state in one PATCH.
        // The PATCH is accepted (202) and applied asynchronously; a failed
        // apply is not reported back, the server just keeps its old values.
        // Wait until the server is Ready AND reflects the change (the state
        // can still read `Ready` right after the PATCH), re-issuing the
        // PATCH a bounded number of times if it does not converge.
        let passwordPending =
          news.administratorLoginPassword !== undefined &&
          reveal(news.administratorLoginPassword) !== reveal(applied);
        const isApplied = (server: ObservedServer) =>
          !hasDelta(serverDelta(server, news, sku, tags, env.tenantId));
        // Poll until the change is applied. A server that stays `Ready`
        // without the change for ~90s dropped the PATCH.
        const awaitApplied = Effect.gen(function* () {
          let readyButDrifted = 0;
          const last = yield* get.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              times: 60,
              until: (server) => {
                if (server === undefined) return false;
                const state = serverStateOf(server);
                if (state === "Failed") return true;
                if (state !== "Succeeded") {
                  readyButDrifted = 0;
                  return false;
                }
                if (isApplied(server)) return true;
                readyButDrifted++;
                return readyButDrifted >= 9;
              },
            }),
          );
          if (last !== undefined && serverStateOf(last) === "Failed") {
            return yield* new ProvisioningFailed({
              resource: label,
              state: last.properties?.state ?? "Disabled",
              message: `${label} is '${last.properties?.state}'`,
            });
          }
          if (
            last === undefined ||
            serverStateOf(last) !== "Succeeded" ||
            !isApplied(last)
          ) {
            return yield* new ProvisioningTimedOut({
              resource: label,
              state: last?.properties?.state,
              message: `${label} did not apply the update (last state: ${last?.properties?.state ?? "not found"})`,
            });
          }
          return last;
        });
        const syncOnce = Effect.gen(function* () {
          const current = yield* waitReady;
          const delta = serverDelta(current, news, sku, tags, env.tenantId);
          if (!hasDelta(delta) && !passwordPending) return current;
          yield* Effect.logDebug(`${label}: applying ${JSON.stringify(delta)}`);
          yield* postgresql
            .UpdateServer({
              ...ref,
              ...delta,
              properties: passwordPending
                ? {
                    ...delta.properties,
                    administratorLoginPassword: news.administratorLoginPassword,
                  }
                : delta.properties,
            })
            .pipe(Effect.retry(whileServerBusy));
          passwordPending = false;
          return yield* awaitApplied;
        });
        observed = yield* syncOnce.pipe(
          Effect.retry({
            while: (e) => e._tag === "Azure.ProvisioningTimedOut",
            times: 2,
          }),
        );
      }

      if (news.createMode === "Replica") {
        observed = yield* waitReplicaAttached(
          label,
          ref,
          news.sourceServerResourceId,
        );
      }

      return toAttrs(resourceGroup, name, observed, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ServerRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.serverName,
      };
      yield* ignoreNotFound(
        postgresql.DeleteServer(ref).pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `PostgreSQL flexible server ${output.serverName}`,
        getServer(ref),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
