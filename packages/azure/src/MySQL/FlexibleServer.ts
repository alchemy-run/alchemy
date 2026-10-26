import * as crypto from "node:crypto";
import * as mysql from "@distilled.cloud/azure/mysql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  ProvisioningFailed,
  ProvisioningTimedOut,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /** Compute size, e.g. `Standard_B1ms`, `Standard_D2ds_v4`. Resizing restarts the server. */
  name: string;
  /** Compute tier matching the size. */
  tier: MySQLSkuTier;
}

export interface FlexibleServerStorage {
  /**
   * Storage size in GiB (20-16384). Storage can only grow in place.
   *
   * :::caution
   * Asking for less than the previous size replaces the server and
   * deletes every database on it.
   * :::
   * @default 20
   */
  storageSizeGB?: number;
  /**
   * Provisioned IOPS (ignored when `autoIoScaling` is enabled).
   * @default Azure's default for the size
   */
  iops?: number;
  /**
   * Grow storage automatically when free space runs low.
   * @default Azure's default (`Enabled`)
   */
  autoGrow?: EnableStatus;
  /**
   * Scale IOPS automatically with the workload.
   * @default Azure's default (`Disabled`)
   */
  autoIoScaling?: EnableStatus;
  /**
   * Keep the binary log on the data disk.
   * @default Azure's default (`Disabled`)
   */
  logOnDisk?: EnableStatus;
  /**
   * Storage redundancy.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "LocalRedundancy"
   */
  storageRedundancy?: "LocalRedundancy" | "ZoneRedundancy";
}

export interface FlexibleServerBackup {
  /**
   * Days to keep automatic backups (1-35).
   * @default 7
   */
  backupRetentionDays?: number;
  /**
   * Hours between automatic backups.
   * @default Azure's default
   */
  backupIntervalHours?: number;
  /**
   * Store backups in the paired region.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "Disabled"
   */
  geoRedundantBackup?: EnableStatus;
}

export interface FlexibleServerNetwork {
  /**
   * Whether the public endpoint accepts traffic (public-access servers
   * only; firewall rules still apply).
   * @default Azure's default (`Enabled` for public-access servers)
   */
  publicNetworkAccess?: EnableStatus;
  /**
   * Subnet delegated to `Microsoft.DBforMySQL/flexibleServers` for VNet
   * integration.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none (public access)
   */
  delegatedSubnetResourceId?: string;
  /**
   * Private DNS zone used with VNet integration, e.g.
   * `<name>.private.mysql.database.azure.com`.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none
   */
  privateDnsZoneResourceId?: string;
}

export interface FlexibleServerHighAvailability {
  /** High availability mode. Not available on the Burstable tier. */
  mode: "Disabled" | "ZoneRedundant" | "SameZone";
  /**
   * Availability zone of the standby server.
   * @default Azure's choice
   */
  standbyAvailabilityZone?: string;
}

export interface FlexibleServerMaintenanceWindow {
  /**
   * `Enabled` to use the custom window below, `Disabled` for a
   * system-managed window.
   * @default Azure's default (`Disabled`)
   */
  customWindow?: EnableStatus;
  /**
   * Start hour (UTC, 0-23).
   * @default 0
   */
  startHour?: number;
  /**
   * Start minute (0-59).
   * @default 0
   */
  startMinute?: number;
  /**
   * Day of the week (0 = Sunday).
   * @default 0
   */
  dayOfWeek?: number;
}

export interface FlexibleServerDataEncryption {
  /**
   * Encryption type.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   */
  type: "SystemManaged" | "AzureKeyVault";
  /**
   * Key Vault key URI for customer-managed keys.
   * @default none
   */
  primaryKeyURI?: string;
  /**
   * User-assigned identity that can read the primary key.
   * @default none
   */
  primaryUserAssignedIdentityId?: string;
  /**
   * Key Vault key URI for geo-redundant backups.
   * @default none
   */
  geoBackupKeyURI?: string;
  /**
   * User-assigned identity that can read the geo-backup key.
   * @default none
   */
  geoBackupUserAssignedIdentityId?: string;
}

export interface FlexibleServerProps {
  /**
   * Resource group the server is created in.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Globally unique server name (it becomes the DNS label
   * `{name}.mysql.database.azure.com`): 3-63 lowercase letters, digits,
   * and hyphens.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default a unique name of at most 32 characters generated from the app, stage, and logical ID (long server names in long resource-group names fail to provision)
   */
  name?: string;
  /**
   * Azure location of the server, e.g. `centralus`.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * MySQL version. A higher version upgrades the server in place (with
   * downtime).
   *
   * :::caution
   * A lower version replaces the server and deletes every database on it.
   * :::
   * @default "8.0.21"
   */
  version?: MySQLVersion;
  /**
   * Compute size and tier. Resizing happens in place and restarts the
   * server.
   * @default { name: "Standard_B1ms", tier: "Burstable" }
   */
  sku?: FlexibleServerSku;
  /**
   * Login of the password-based administrator. Must not be `admin`,
   * `administrator`, `root`, `guest`, `public`, or a similar reserved name.
   *
   * :::caution
   * Azure cannot change the login after creation. Changing it replaces the
   * server and deletes every database on it.
   * :::
   * @default "alchemyadmin"
   */
  administratorLogin?: string;
  /**
   * Administrator password: 8-128 characters from three of upper case,
   * lower case, digits, and symbols. Changing it updates the server in
   * place.
   * @default a random password generated on create and exposed as the `administratorLoginPassword` attribute
   */
  administratorLoginPassword?: Redacted.Redacted<string>;
  /**
   * Storage configuration.
   * @default { storageSizeGB: 20, storageRedundancy: "LocalRedundancy" }
   */
  storage?: FlexibleServerStorage;
  /**
   * Automatic backup configuration.
   * @default { backupRetentionDays: 7, geoRedundantBackup: "Disabled" }
   */
  backup?: FlexibleServerBackup;
  /**
   * Network configuration.
   * @default a public-access server with no firewall rules
   */
  network?: FlexibleServerNetwork;
  /**
   * High availability configuration (General Purpose and Memory Optimized
   * tiers only).
   * @default { mode: "Disabled" }
   */
  highAvailability?: FlexibleServerHighAvailability;
  /**
   * Availability zone of the primary server, set at creation.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default Azure's choice
   */
  availabilityZone?: string;
  /**
   * Maintenance window.
   * @default a system-managed window
   */
  maintenanceWindow?: FlexibleServerMaintenanceWindow;
  /**
   * Data encryption (system-managed or customer-managed keys).
   * @default { type: "SystemManaged" }
   */
  dataEncryption?: FlexibleServerDataEncryption;
  /**
   * ARM IDs of user-assigned managed identities to attach (needed for
   * customer-managed keys and Microsoft Entra administrators).
   * @default []
   */
  userAssignedIdentityIds?: string[];
  /**
   * TCP port the server listens on.
   *
   * :::caution
   * Changing the port replaces the server and deletes every database on it.
   * :::
   * @default 3306
   */
  databasePort?: number;
  /**
   * How the server is created. `Replica` creates a read replica of
   * `sourceServerResourceId`; `PointInTimeRestore` and `GeoRestore`
   * restore it.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "Default"
   */
  createMode?: "Default" | "Replica" | "PointInTimeRestore" | "GeoRestore";
  /**
   * Source server for `Replica`, `PointInTimeRestore`, and `GeoRestore`.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none
   */
  sourceServerResourceId?: string;
  /**
   * Restore point (ISO 8601) for `PointInTimeRestore` and `GeoRestore`.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none
   */
  restorePointInTime?: string;
  /**
   * Replication role. Set `None` on a replica to promote it to a
   * standalone server.
   * @default Azure's value for the create mode
   */
  replicationRole?: "None" | "Source" | "Replica";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * An Azure Database for MySQL flexible server
 * (`Microsoft.DBforMySQL/flexibleServers`): a managed MySQL server that
 * holds your databases.
 *
 * Alchemy creates the cheapest configuration by default: Burstable
 * `Standard_B1ms`, 20 GiB storage, MySQL 8.0, and public access with no
 * firewall rules, so no client connects until you add an
 * `Azure.MySQL.FirewallRule` or put the server in a VNet. If you give no
 * password, Alchemy generates one and exposes it, with a `mysql://`
 * connection URL that requires TLS, as redacted attributes. Creation takes
 * several minutes; the deploy waits until the server is `Ready`.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, `administratorLogin`, `createMode`, `availabilityZone`, or `databasePort` replaces the server]
 * Alchemy creates a new, empty server and deletes the old one with every
 * database on it. A lower `version`, a smaller `storage.storageSizeGB`, and
 * changes to `storage.storageRedundancy`, `backup.geoRedundantBackup`,
 * `dataEncryption.type`, the delegated subnet, the private DNS zone,
 * `sourceServerResourceId`, or `restorePointInTime` replace it too.
 * :::
 *
 * :::caution[A deploy starts a stopped server]
 * Azure rejects updates to a stopped server, so Alchemy starts a server you
 * stopped (for example with `Azure.MySQL.StopServer`) before it syncs the
 * settings.
 * :::
 *
 * See [Azure Database for MySQL flexible server](https://learn.microsoft.com/azure/mysql/flexible-server/overview).
 *
 * ### Creating a Server
 * **Example:** Burstable server with a generated password
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   location: "centralus",
 * });
 * // server.fullyQualifiedDomainName → "<name>.mysql.database.azure.com"
 * // server.connectionString is a Redacted mysql:// URL for the administrator
 * ```
 *
 * **Example:** General Purpose server on MySQL 8.4
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("MYSQL_PASSWORD");
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   version: "8.4",
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 *   storage: { storageSizeGB: 128, autoGrow: "Enabled", autoIoScaling: "Enabled" },
 *   administratorLoginPassword: password,
 * });
 * ```
 *
 * ### Databases and Parameters
 * **Example:** Create a database and set a server parameter
 * ```typescript
 * const db = yield* Azure.MySQL.Database("App", {
 *   server: server.serverName,
 *   name: "app",
 * });
 * yield* Azure.MySQL.Configuration("SlowLog", {
 *   server: server.serverName,
 *   name: "slow_query_log",
 *   value: "ON",
 * });
 * ```
 *
 * ### Firewall Rules
 * **Example:** Allow Azure services
 * ```typescript
 * // Flex Consumption Functions have no fixed outbound IP. The 0.0.0.0 rule
 * // lets Azure services in; the server still requires TLS and a password.
 * yield* Azure.MySQL.FirewallRule("AllowAzureServices", {
 *   server: server.serverName,
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * **Example:** Allow an office range
 * ```typescript
 * yield* Azure.MySQL.FirewallRule("Office", {
 *   server: server.serverName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * ### Private Networking
 * **Example:** Server inside a delegated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("Db", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.DBforMySQL/flexibleServers" }],
 * });
 * const zone = yield* Azure.PrivateDns.Zone("MySqlZone", {
 *   name: "app.private.mysql.database.azure.com",
 * });
 * yield* Azure.PrivateDns.VirtualNetworkLink("MySqlZoneLink", {
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 *   network: {
 *     delegatedSubnetResourceId: subnet.subnetId,
 *     privateDnsZoneResourceId: zone.privateZoneId,
 *   },
 * });
 * ```
 *
 * **Example:** Turn off the public endpoint
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   network: { publicNetworkAccess: "Disabled" },
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Make an Entra group the administrator
 * ```typescript
 * // MySQL reads Entra users through a user-assigned identity on the server.
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("MySqlEntra");
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   userAssignedIdentityIds: [identity.identityId],
 * });
 * yield* Azure.MySQL.Administrator("Dbas", {
 *   server: server.serverName,
 *   login: "db-admins",
 *   sid: "00000000-0000-0000-0000-000000000000", // the group's object ID
 *   identityResourceId: identity.identityId,
 * });
 * ```
 *
 * ### High Availability
 * **Example:** Zone-redundant standby
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 *   highAvailability: { mode: "ZoneRedundant" },
 *   storage: { storageRedundancy: "ZoneRedundancy" },
 * });
 * ```
 *
 * ### Backups and Restores
 * **Example:** Keep backups for 14 days in the paired region
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("MySql", {
 *   backup: { backupRetentionDays: 14, geoRedundantBackup: "Enabled" },
 * });
 * ```
 *
 * **Example:** Restore a point in time into a new server
 * ```typescript
 * const restored = yield* Azure.MySQL.FlexibleServer("Restored", {
 *   createMode: "PointInTimeRestore",
 *   sourceServerResourceId: server.serverId,
 *   restorePointInTime: "2026-10-24T12:00:00Z",
 * });
 * ```
 *
 * ### Read Replicas
 * **Example:** Replica of an existing server
 * ```typescript
 * const replica = yield* Azure.MySQL.FlexibleServer("Replica", {
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 * });
 * ```
 *
 * **Example:** Promote the replica to a standalone server
 * ```diff
 * const replica = yield* Azure.MySQL.FlexibleServer("Replica", {
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v4", tier: "GeneralPurpose" },
 * +  replicationRole: "None",
 * });
 * ```
 *
 * ### Binding to a runtime
 * MySQL has no data-plane binding: the runtime connects with a MySQL driver
 * over TLS. Yield an Output of the server inside the host. Alchemy puts the
 * value in the host's app settings and returns an Effect that reads it at
 * runtime. The host's identity gets no role.
 *
 * **Example:** Read the connection values inside an Azure Function
 * ```typescript
 * // init
 * const host = yield* server.fullyQualifiedDomainName;
 * const databaseName = yield* db.databaseName;
 *
 * // runtime
 * const hostName = yield* host;
 * const name = yield* databaseName;
 * // connect with a MySQL driver (e.g. @effect/sql-mysql2) to hostName:3306/name over TLS
 * ```
 *
 * ### Runtime Operations
 * `StopServer`, `StartServer`, `RestartServer`, and `FailoverServer` each
 * assign a custom role with exactly one action on this server only, to the
 * host's managed identity or, on any other host, to an Entra service
 * principal.
 *
 * **Example:** Stop the server at night and start it in the morning
 * ```typescript
 * // init
 * const stopServer = yield* Azure.MySQL.StopServer(server);
 * const startServer = yield* Azure.MySQL.StartServer(server);
 *
 * // runtime: compute billing stops while stopped; Azure starts it again after 30 days
 * yield* stopServer();
 * yield* startServer();
 * // …provided with Effect.provide([Azure.MySQL.StopServerHttp, Azure.MySQL.StartServerHttp])
 * ```
 *
 * **Example:** Fail a zone-redundant server over to its standby
 * ```typescript
 * // init
 * const failoverServer = yield* Azure.MySQL.FailoverServer(server);
 * const restartServer = yield* Azure.MySQL.RestartServer(server);
 *
 * // runtime
 * yield* failoverServer();
 * yield* restartServer({ restartWithFailover: "Disabled" });
 * // …provided with Effect.provide([Azure.MySQL.FailoverServerHttp, Azure.MySQL.RestartServerHttp])
 * ```
 *
 * ### Deleting a Server
 * Destroying the server deletes every database on it.
 *
 * **Example:** Keep the server when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const server = yield* Azure.MySQL.FlexibleServer("MySql").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const FlexibleServer = GroupedResource<FlexibleServer>("Azure.MySQL.FlexibleServer");

type ObservedServer = mysql.GetServerResponse;

const DEFAULT_SKU: FlexibleServerSku = {
  name: "Standard_B1ms",
  tier: "Burstable",
};
const DEFAULT_LOGIN = "alchemyadmin";
const DEFAULT_VERSION = "8.0.21";

/**
 * Azure allows 63 characters, but creation fails asynchronously with an
 * opaque `InternalServerError` when a long server name meets a long resource
 * group name (63 + 90 fails; 24 + 90 and 63 + 65 succeed), so generated names
 * stay short.
 */
const createServerName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 32,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/** Random password satisfying Azure's complexity rules (all four classes). */
const generatePassword = Effect.sync(() =>
  Redacted.make(`Aa1-${Buffer.from(crypto.randomBytes(24)).toString("base64url")}`),
);

const reveal = (value: Redacted.Redacted<string> | string | undefined): string | undefined =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const lower = (value: string | undefined) => value?.toLowerCase();

/** ARM may report locations by display name (`Central US`). */
const normalizeLocation = (value: string | undefined) => value?.replace(/\s+/g, "").toLowerCase();

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

const identityInput = (ids: string[] | undefined): mysql.MySQLServerIdentityInput | undefined =>
  ids === undefined || ids.length === 0
    ? undefined
    : {
        type: "UserAssigned",
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      };

const identityDiffers = (observed: mysql.MySQLServerIdentity | undefined, desired: string[]) => {
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
): Omit<mysql.UpdateServerRequest, "subscriptionId" | "resourceGroupName" | "serverName"> => {
  const props = observed.properties ?? {};
  const properties: mysql.ServerPropertiesForUpdateInput = {};

  if (news.version !== undefined && compareVersions(news.version, props.version ?? "0") > 0) {
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
  if (publicAccess !== undefined && publicAccess !== props.network?.publicNetworkAccess) {
    properties.network = { publicNetworkAccess: publicAccess };
  }

  const encryption = news.dataEncryption;
  if (encryption !== undefined) {
    const changed = changedFields(props.dataEncryption, {
      primaryKeyURI: encryption.primaryKeyURI,
      primaryUserAssignedIdentityId: encryption.primaryUserAssignedIdentityId,
      geoBackupKeyURI: encryption.geoBackupKeyURI,
      geoBackupUserAssignedIdentityId: encryption.geoBackupUserAssignedIdentityId,
    });
    if (changed) properties.dataEncryption = { ...encryption };
  }

  if (news.replicationRole !== undefined && news.replicationRole !== props.replicationRole) {
    properties.replicationRole = news.replicationRole;
  }

  return {
    sku: observed.sku?.name !== sku.name || observed.sku?.tier !== sku.tier ? sku : undefined,
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
      const page = yield* collectAll(mysql.ListServers, { subscriptionId });
      return (page.value ?? []).flatMap((server) => {
        const group = resourceGroupOf(server.id);
        return hasAnyAlchemyTag(server.tags) && group !== undefined && server.name !== undefined
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
          normalizeLocation(news.location) !== normalizeLocation(output.location)) ||
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
        (news.storage?.storageSizeGB ?? 0) < (before.storage?.storageSizeGB ?? 0) ||
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
      const name = output?.serverName ?? olds?.name ?? (yield* createServerName(id));
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
      const name = news.name ?? output?.serverName ?? (yield* createServerName(id));
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
      const applied = output?.administratorLoginPassword ?? olds?.administratorLoginPassword;
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
              version: news.version ?? (passwordCreate ? DEFAULT_VERSION : undefined),
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
        // GET answers 404 until creation completes (≈ 3 min). The PUT answers
        // 202 and can then fail asynchronously (`InternalServerError`
        // ≈ 5 min in, `ProvisionNotSupportedForRegion`); that error is only on
        // the async operation, so the server simply never appears.
        const appeared = yield* get.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (server) => server !== undefined,
            times: 60,
          }),
        );
        if (appeared === undefined) {
          return yield* new ProvisioningFailed({
            resource: label,
            state: "NotCreated",
            message: `${label} did not appear in '${location}' within 10 minutes; the create request was rejected asynchronously (InternalServerError, or ProvisionNotSupportedForRegion — see https://aka.ms/mysqlcapacity)`,
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
      const isApplied = (server: ObservedServer) => !hasDelta(serverDelta(server, news, sku, tags));
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
        if (last === undefined || serverStateOf(last) !== "Succeeded" || !isApplied(last)) {
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
      yield* ignoreNotFound(mysql.DeleteServer(ref).pipe(Effect.retry(whileServerBusy)));
      yield* waitUntilGone(`MySQL flexible server ${output.serverName}`, getServer(ref), {
        interval: "10 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
