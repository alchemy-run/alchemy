import * as mysql from "@distilled.cloud/azure/mysql";
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
  MYSQL_NAMESPACE,
  type ServerRef,
  waitServerSettled,
  whileServerBusy,
} from "./common.ts";

/** MySQL server version. */
export type MySQLVersion = "5.7" | "8.0.21" | "8.4" | (string & {});
export type MySQLSkuTier = "Burstable" | "GeneralPurpose" | "MemoryOptimized";
type EnableStatus = "Enabled" | "Disabled";

export interface FlexibleServerSku {
  /** Compute size, e.g. `Standard_B1ms`, `Standard_D2ds_v4`. */
  name: string;
  /** Compute tier matching the size. */
  tier: MySQLSkuTier;
}

export interface FlexibleServerStorage {
  /**
   * Storage size in GiB (20-16384). Can only grow in place; asking for less
   * than the previously requested size replaces the server.
   * @default 20
   */
  storageSizeGB?: number;
  /** Provisioned IOPS (ignored when `autoIoScaling` is enabled). */
  iops?: number;
  /** Grow storage automatically when free space runs low. */
  autoGrow?: EnableStatus;
  /** Scale IOPS automatically with the workload. */
  autoIoScaling?: EnableStatus;
  /** Keep the binary log on the data disk. */
  logOnDisk?: EnableStatus;
  /**
   * Storage redundancy. Changing it replaces the server.
   * @default "LocalRedundancy"
   */
  storageRedundancy?: "LocalRedundancy" | "ZoneRedundancy";
}

export interface FlexibleServerBackup {
  /**
   * Days to retain automatic backups (1-35).
   * @default 7
   */
  backupRetentionDays?: number;
  /** Hours between automatic backups. */
  backupIntervalHours?: number;
  /**
   * Store backups in the paired region. Changing it replaces the server.
   * @default "Disabled"
   */
  geoRedundantBackup?: EnableStatus;
}

export interface FlexibleServerNetwork {
  /**
   * Whether the public endpoint accepts traffic (public-access servers only;
   * firewall rules still apply).
   */
  publicNetworkAccess?: EnableStatus;
  /**
   * Subnet delegated to `Microsoft.DBforMySQL/flexibleServers` for VNet
   * integration. Changing it replaces the server.
   */
  delegatedSubnetResourceId?: string;
  /**
   * Private DNS zone used with VNet integration. Changing it replaces the
   * server.
   */
  privateDnsZoneResourceId?: string;
}

export interface FlexibleServerHighAvailability {
  /** High availability mode. Not available on the Burstable tier. */
  mode: "Disabled" | "ZoneRedundant" | "SameZone";
  /** Availability zone of the standby server. */
  standbyAvailabilityZone?: string;
}

export interface FlexibleServerMaintenanceWindow {
  /** `Enabled` to use the custom window below, `Disabled` for system-managed. */
  customWindow?: EnableStatus;
  /** Start hour (UTC, 0-23). */
  startHour?: number;
  /** Start minute (0-59). */
  startMinute?: number;
  /** Day of the week (0 = Sunday). */
  dayOfWeek?: number;
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

export interface FlexibleServerProps {
  /** Resource group the server is created in. Changing it replaces the server. */
  resourceGroup: string;
  /**
   * Globally unique server name (it becomes the DNS label
   * `{name}.mysql.database.azure.com`): 3-63 lowercase letters, digits,
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
   * MySQL version. Upgrades happen in place; a downgrade replaces the
   * server.
   * @default "8.0.21"
   */
  version?: MySQLVersion;
  /**
   * Compute size and tier.
   * @default { name: "Standard_B1ms", tier: "Burstable" }
   */
  sku?: FlexibleServerSku;
  /**
   * Login of the password-based administrator. Cannot change after
   * creation: changing it replaces the server. Must not be `admin`,
   * `administrator`, `root`, `guest`, `public`, or similar reserved names.
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
  /** Data encryption (system-managed or customer-managed keys). */
  dataEncryption?: FlexibleServerDataEncryption;
  /**
   * ARM IDs of user-assigned managed identities to attach (needed for
   * customer-managed keys and Microsoft Entra administrators).
   */
  userAssignedIdentityIds?: string[];
  /**
   * TCP port the server listens on.
   * @default 3306
   */
  databasePort?: number;
  /**
   * How the server is created. `Replica` creates a read replica of
   * `sourceServerResourceId`; `PointInTimeRestore`/`GeoRestore` restore
   * it. Changing it replaces the server.
   * @default "Default"
   */
  createMode?: "Default" | "Replica" | "PointInTimeRestore" | "GeoRestore";
  /**
   * Source server for `Replica`, `PointInTimeRestore`, and `GeoRestore`.
   * Changing it replaces the server.
   */
  sourceServerResourceId?: string;
  /**
   * Restore point (ISO 8601) for `PointInTimeRestore`/`GeoRestore`.
   * Changing it replaces the server.
   */
  restorePointInTime?: string;
  /**
   * Replication role. Set `None` on a replica to promote it to a
   * standalone server.
   */
  replicationRole?: "None" | "Source" | "Replica";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface FlexibleServer extends Resource<
  "Azure.MySQL.FlexibleServer",
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
    /** Host name, e.g. `{name}.mysql.database.azure.com`. */
    fullyQualifiedDomainName: string;
    /** TCP port the server listens on. */
    databasePort: number;
    /** Server state (`Ready`, `Stopped`, …). */
    state: string;
    /** MySQL version. */
    version: string;
    /** Full MySQL version, e.g. `8.0.39`. */
    fullVersion: string | undefined;
    /** Compute size. */
    skuName: string;
    /** Compute tier. */
    skuTier: string;
    /** Availability zone of the primary server. */
    availabilityZone: string | undefined;
    /** Role in a replication set (`None`, `Source`, `Replica`). */
    replicationRole: string | undefined;
    /** Maximum number of replicas the server supports. */
    replicaCapacity: number | undefined;
    /** Login of the password-based administrator. */
    administratorLogin: string | undefined;
    /**
     * Administrator password last applied by Alchemy (the given or the
     * generated one). `undefined` for adopted servers whose password is
     * unknown.
     */
    administratorLoginPassword: Redacted.Redacted<string> | undefined;
    /**
     * `mysql://` connection URL for the administrator, with TLS required.
     */
    connectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Database for MySQL flexible server.
 *
 * Servers default to the cheapest configuration — Burstable
 * `Standard_B1ms`, 20 GiB storage, MySQL 8.0, public access with no
 * firewall rules (add `MySQL.FirewallRule`s to let clients in). Creation
 * takes several minutes.
 *
 * @see https://learn.microsoft.com/azure/mysql/flexible-server/overview
 *
 * ### Creating a Server
 * **Example:** Burstable server with a generated password
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const server = yield* Azure.MySQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // server.connectionString is a Redacted mysql:// URL
 * ```
 *
 * **Example:** General Purpose server with longer backup retention
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 *   version: "8.4",
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 *   storage: { storageSizeGB: 128, autoGrow: "Enabled" },
 *   backup: { backupRetentionDays: 14 },
 *   administratorLoginPassword: yield* Config.redacted("MYSQL_PASSWORD"),
 * });
 * ```
 *
 * ### Read Replicas
 * **Example:** Replica of an existing server
 * ```typescript
 * const replica = yield* Azure.MySQL.FlexibleServer("replica", {
 *   resourceGroup: group.resourceGroupName,
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 * });
 * ```
 *
 * @resource
 */
export const FlexibleServer = Resource<FlexibleServer>(
  "Azure.MySQL.FlexibleServer",
);

type ObservedServer = mysql.GetServerResponse;

const DEFAULT_SKU: FlexibleServerSku = {
  name: "Standard_B1ms",
  tier: "Burstable",
};
const DEFAULT_LOGIN = "alchemyadmin";
const DEFAULT_VERSION = "8.0.21";

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
  Redacted.make(`Aa1-${crypto.randomBytes(24).toString("base64url")}`),
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

/** ARM may report locations by display name (`Central US`). */
const normalizeLocation = (value: string | undefined) =>
  value?.replace(/\s+/g, "").toLowerCase();

/** Compare dotted versions (`5.7` < `8.0.21` < `8.4`). */
const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const isPasswordCreate = (props: FlexibleServerProps) =>
  (props.createMode ?? "Default") === "Default";

const connectionStringOf = (
  login: string | undefined,
  password: Redacted.Redacted<string> | undefined,
  fqdn: string | undefined,
  port: number,
) =>
  login !== undefined && password !== undefined && fqdn
    ? Redacted.make(
        `mysql://${encodeURIComponent(login)}:${encodeURIComponent(
          Redacted.value(password),
        )}@${fqdn}:${port}/?ssl-mode=REQUIRED`,
      )
    : undefined;

const toAttrs = (
  resourceGroup: string,
  name: string,
  server: ObservedServer,
  password: Redacted.Redacted<string> | undefined,
): FlexibleServer["Attributes"] => {
  const props = server.properties ?? {};
  const port = props.databasePort ?? 3306;
  return {
    serverName: name,
    serverId: server.id ?? "",
    resourceGroup,
    location: server.location,
    fullyQualifiedDomainName: props.fullyQualifiedDomainName ?? "",
    databasePort: port,
    state: props.state ?? "",
    version: props.version ?? "",
    fullVersion: props.fullVersion,
    skuName: server.sku?.name ?? "",
    skuTier: server.sku?.tier ?? "",
    availabilityZone: props.availabilityZone || undefined,
    replicationRole: props.replicationRole,
    replicaCapacity: props.replicaCapacity,
    administratorLogin: props.administratorLogin,
    administratorLoginPassword: password,
    connectionString: connectionStringOf(
      props.administratorLogin,
      password,
      props.fullyQualifiedDomainName,
      port,
    ),
    tags: userTags(server.tags),
  };
};

const identityInput = (
  ids: string[] | undefined,
): mysql.MySQLServerIdentityInput | undefined =>
  ids === undefined || ids.length === 0
    ? undefined
    : {
        type: "UserAssigned",
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      };

const identityDiffers = (
  observed: mysql.MySQLServerIdentity | undefined,
  desired: string[],
) => {
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = desired.map((id) => id.toLowerCase()).sort();
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
 * The PATCH body that moves `observed` to the desired state, or an
 * all-undefined object when the server already matches. The password is
 * not observable and is handled by the caller.
 */
const serverDelta = (
  observed: ObservedServer,
  news: FlexibleServerProps,
  sku: FlexibleServerSku,
  tags: Record<string, string>,
): Omit<
  mysql.UpdateServerRequest,
  "subscriptionId" | "resourceGroupName" | "serverName"
> => {
  const props = observed.properties ?? {};
  const properties: mysql.ServerPropertiesForUpdateInput = {};

  if (
    news.version !== undefined &&
    compareVersions(news.version, props.version ?? "0") > 0
  ) {
    properties.version = news.version;
  }

  const storage = news.storage;
  if (storage !== undefined) {
    const changed: mysql.StorageInput = {};
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
        autoIoScaling: storage.autoIoScaling,
        logOnDisk: storage.logOnDisk,
        iops: storage.autoIoScaling === "Enabled" ? undefined : storage.iops,
      }),
    );
    if (Object.keys(changed).length > 0) properties.storage = changed;
  }

  const backup = changedFields(props.backup, {
    backupRetentionDays: news.backup?.backupRetentionDays,
    backupIntervalHours: news.backup?.backupIntervalHours,
  });
  if (backup) properties.backup = backup;

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

  if (
    news.replicationRole !== undefined &&
    news.replicationRole !== props.replicationRole
  ) {
    properties.replicationRole = news.replicationRole;
  }

  return {
    sku:
      observed.sku?.name !== sku.name || observed.sku?.tier !== sku.tier
        ? sku
        : undefined,
    identity:
      news.userAssignedIdentityIds !== undefined &&
      news.userAssignedIdentityIds.length > 0 &&
      identityDiffers(observed.identity, news.userAssignedIdentityIds)
        ? identityInput(news.userAssignedIdentityIds)
        : undefined,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    tags: tagsDiffer(observed.tags, tags) ? tags : undefined,
  };
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
      const page = yield* mysql
        .ListServers({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListServers", page)));
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
          compareVersions(news.version, output.version) < 0) ||
        (news.administratorLogin ?? DEFAULT_LOGIN) !==
          (before.administratorLogin ?? DEFAULT_LOGIN) ||
        (news.createMode ?? "Default") !== (before.createMode ?? "Default") ||
        news.sourceServerResourceId !== before.sourceServerResourceId ||
        news.restorePointInTime !== before.restorePointInTime ||
        news.availabilityZone !== before.availabilityZone ||
        (news.storage?.storageRedundancy ?? "LocalRedundancy") !==
          (before.storage?.storageRedundancy ?? "LocalRedundancy") ||
        (news.storage?.storageSizeGB ?? 0) <
          (before.storage?.storageSizeGB ?? 0) ||
        (news.backup?.geoRedundantBackup ?? "Disabled") !==
          (before.backup?.geoRedundantBackup ?? "Disabled") ||
        lower(news.network?.delegatedSubnetResourceId) !==
          lower(before.network?.delegatedSubnetResourceId) ||
        lower(news.network?.privateDnsZoneResourceId) !==
          lower(before.network?.privateDnsZoneResourceId) ||
        (news.dataEncryption?.type ?? "SystemManaged") !==
          (before.dataEncryption?.type ?? "SystemManaged") ||
        (news.databasePort ?? 3306) !== (before.databasePort ?? 3306)
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
      yield* ensureRegistered(subscriptionId, MYSQL_NAMESPACE);
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
      const label = `MySQL flexible server ${name}`;
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

      // Ensure. Creation is a long-running operation.
      const created = observed === undefined;
      if (observed === undefined) {
        const passwordCreate = isPasswordCreate(news);
        if (passwordCreate && password === undefined) {
          password = yield* generatePassword;
        }
        yield* mysql
          .CreateServer({
            ...ref,
            location,
            tags,
            sku,
            identity: identityInput(news.userAssignedIdentityIds),
            properties: {
              createMode: news.createMode ?? "Default",
              administratorLogin: passwordCreate
                ? (news.administratorLogin ?? DEFAULT_LOGIN)
                : undefined,
              administratorLoginPassword: passwordCreate ? password : undefined,
              version:
                news.version ?? (passwordCreate ? DEFAULT_VERSION : undefined),
              storage: {
                ...news.storage,
                storageSizeGB: news.storage?.storageSizeGB ?? 20,
              },
              backup: news.backup,
              network: news.network,
              highAvailability: news.highAvailability,
              maintenanceWindow: news.maintenanceWindow,
              dataEncryption: news.dataEncryption,
              availabilityZone: news.availabilityZone,
              databasePort: news.databasePort,
              sourceServerResourceId: news.sourceServerResourceId,
              restorePointInTime: news.restorePointInTime,
              replicationRole: news.replicationRole,
            },
          })
          .pipe(Effect.retry(whileServerBusy));
        // GET answers 404 until creation completes. The PUT answers 202 and
        // can then fail asynchronously (e.g. `ProvisionNotSupportedForRegion`);
        // that error is only on the async operation, so the server simply
        // never appears.
        const appeared = yield* get.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (server) => server !== undefined,
            times: 120,
          }),
        );
        if (appeared === undefined) {
          return yield* new ProvisioningFailed({
            resource: label,
            state: "NotCreated",
            message: `${label} did not appear in '${location}' within 20 minutes; the create request was likely rejected asynchronously (often ProvisionNotSupportedForRegion — see https://aka.ms/mysqlcapacity)`,
          });
        }
        observed = yield* waitReady;
      }

      // Sync every mutable aspect against observed state in one PATCH. A
      // stopped server rejects updates; start it to converge.
      const settled = yield* waitServerSettled(ref);
      if (settled?.properties?.state === "Stopped") {
        yield* mysql.StartServer(ref).pipe(Effect.retry(whileServerBusy));
      }

      // The PATCH is applied asynchronously; a failed apply is not always
      // reported back, the server just keeps its old values. Wait until the
      // server is Ready AND reflects the change, re-issuing the PATCH a
      // bounded number of times if it does not converge.
      let passwordPending =
        !created &&
        news.administratorLoginPassword !== undefined &&
        reveal(news.administratorLoginPassword) !== reveal(applied);
      const isApplied = (server: ObservedServer) =>
        !hasDelta(serverDelta(server, news, sku, tags));
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
        const delta = serverDelta(current, news, sku, tags);
        if (!hasDelta(delta) && !passwordPending) return current;
        yield* Effect.logDebug(`${label}: applying ${JSON.stringify(delta)}`);
        yield* mysql
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
        mysql.DeleteServer(ref).pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `MySQL flexible server ${output.serverName}`,
        getServer(ref),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
