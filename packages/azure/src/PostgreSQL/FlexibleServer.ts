import * as crypto from "node:crypto";
import * as postgresql from "@distilled.cloud/azure/postgresql";
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
  POSTGRES_NAMESPACE,
  type ServerRef,
  waitServerSettled,
  whileServerBusy,
} from "./common.ts";

export type PostgresMajorVersion = postgresql.PostgresMajorVersion;
export type PostgresSkuTier = postgresql.SkuTier;
export type PostgresStorageTier = postgresql.AzureManagedDiskPerformanceTier;

export interface FlexibleServerSku {
  /** Compute size, e.g. `Standard_B1ms`, `Standard_D2ds_v5`. Resizing restarts the server. */
  name: string;
  /** Compute tier matching the size. */
  tier: PostgresSkuTier;
}

export interface FlexibleServerStorage {
  /**
   * Storage size in GiB (32, 64, 128, … 32768). Storage can only grow in
   * place.
   *
   * :::caution
   * Asking for less than the previous size replaces the server and
   * deletes every database on it.
   * :::
   * @default 32
   */
  storageSizeGB?: number;
  /**
   * Grow storage automatically when free space runs low.
   * @default Azure's default (`Disabled`)
   */
  autoGrow?: "Enabled" | "Disabled";
  /**
   * Performance tier of the managed disk (`P4` … `P80`).
   * @default Azure's default for the size
   */
  tier?: PostgresStorageTier;
  /**
   * Disk type.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "Premium_LRS"
   */
  type?: "Premium_LRS" | "PremiumV2_LRS";
  /**
   * Provisioned IOPS (`PremiumV2_LRS` only).
   * @default Azure's default for the size
   */
  iops?: number;
  /**
   * Provisioned throughput in MB/s (`PremiumV2_LRS` only).
   * @default Azure's default for the size
   */
  throughput?: number;
}

export interface FlexibleServerBackup {
  /**
   * Days to keep automatic backups (7-35).
   * @default 7
   */
  backupRetentionDays?: number;
  /**
   * Store backups in the paired region.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "Disabled"
   */
  geoRedundantBackup?: "Enabled" | "Disabled";
}

export interface FlexibleServerNetwork {
  /**
   * Whether the public endpoint accepts traffic (public-access servers
   * only; firewall rules still apply).
   * @default Azure's default (`Enabled` for public-access servers)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Subnet delegated to `Microsoft.DBforPostgreSQL/flexibleServers` for
   * VNet integration.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none (public access)
   */
  delegatedSubnetResourceId?: string;
  /**
   * Private DNS zone used with VNet integration, e.g.
   * `<name>.private.postgres.database.azure.com`.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default none
   */
  privateDnsZoneArmResourceId?: string;
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
  customWindow?: "Enabled" | "Disabled";
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

export interface FlexibleServerAuthConfig {
  /**
   * Allow Microsoft Entra authentication. Add an
   * `Azure.PostgreSQL.Administrator` to sign in with it.
   * @default "Disabled"
   */
  activeDirectoryAuth?: "Enabled" | "Disabled";
  /**
   * Allow password authentication.
   * @default "Enabled"
   */
  passwordAuth?: "Enabled" | "Disabled";
  /**
   * Tenant for Microsoft Entra authentication.
   * @default the deploying subscription's tenant when Entra auth is enabled
   */
  tenantId?: string;
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

export interface FlexibleServerIdentity {
  /** Identity type. */
  type: "None" | "UserAssigned" | "SystemAssigned" | "SystemAssigned,UserAssigned";
  /**
   * ARM IDs of user-assigned identities to attach.
   * @default []
   */
  userAssignedIdentityIds?: string[];
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
   * `{name}.postgres.database.azure.com`): 3-63 lowercase letters, digits,
   * and hyphens.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
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
   * PostgreSQL major version. A higher version upgrades the server in
   * place (with downtime).
   *
   * :::caution
   * A lower version replaces the server and deletes every database on it.
   * :::
   * @default "16"
   */
  version?: PostgresMajorVersion;
  /**
   * Compute size and tier. Resizing happens in place and restarts the
   * server.
   * @default { name: "Standard_B1ms", tier: "Burstable" }
   */
  sku?: FlexibleServerSku;
  /**
   * Login of the password-based administrator. Must not be `admin`,
   * `administrator`, `root`, `guest`, `public`, or start with `pg_`.
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
   * @default { storageSizeGB: 32, type: "Premium_LRS" }
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
   * Authentication methods.
   * @default password authentication only
   */
  authConfig?: FlexibleServerAuthConfig;
  /**
   * Data encryption (system-managed or customer-managed keys).
   * @default { type: "SystemManaged" }
   */
  dataEncryption?: FlexibleServerDataEncryption;
  /**
   * Managed identities of the server. Customer-managed keys need a
   * user-assigned identity.
   * @default no identity
   */
  identity?: FlexibleServerIdentity;
  /**
   * How the server is created. `Replica` creates a read replica of
   * `sourceServerResourceId`; `PointInTimeRestore` and `GeoRestore`
   * restore it.
   *
   * :::caution
   * Changing it replaces the server and deletes every database on it.
   * :::
   * @default "Create"
   */
  createMode?: "Create" | "Replica" | "PointInTimeRestore" | "GeoRestore";
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
  pointInTimeUTC?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * An Azure Database for PostgreSQL flexible server
 * (`Microsoft.DBforPostgreSQL/flexibleServers`): a managed PostgreSQL
 * server that holds your databases.
 *
 * Alchemy creates the cheapest configuration by default: Burstable
 * `Standard_B1ms`, 32 GiB Premium SSD, PostgreSQL 16, password
 * authentication, and public access with no firewall rules, so no client
 * connects until you add an `Azure.PostgreSQL.FirewallRule` or put the
 * server in a VNet. If you give no password, Alchemy generates one and
 * exposes it, with a `postgresql://` connection string, as redacted
 * attributes. Creation takes several minutes; the deploy waits until the
 * server is `Ready`.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, `administratorLogin`, `createMode`, or `availabilityZone` replaces the server]
 * Alchemy creates a new, empty server and deletes the old one with every
 * database on it. A lower `version`, a smaller `storage.storageSizeGB`, and
 * changes to `storage.type`, `backup.geoRedundantBackup`,
 * `dataEncryption.type`, the delegated subnet, the private DNS zone,
 * `sourceServerResourceId`, or `pointInTimeUTC` replace it too.
 * :::
 *
 * :::caution[A deploy starts a stopped server]
 * Azure rejects updates to a stopped server, so Alchemy starts a server you
 * stopped (for example with `Azure.PostgreSQL.StopServer`) before it syncs
 * the settings.
 * :::
 *
 * See [Azure Database for PostgreSQL flexible server](https://learn.microsoft.com/azure/postgresql/flexible-server/overview).
 *
 * ### Creating a Server
 * **Example:** Burstable server with a generated password
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   location: "centralus",
 *   version: "17",
 * });
 * // server.fullyQualifiedDomainName → "<name>.postgres.database.azure.com"
 * // server.connectionString is a Redacted postgresql:// URL for the administrator
 * ```
 *
 * **Example:** Password from a stable random value
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Output from "alchemy/Output";
 * import * as Redacted from "effect/Redacted";
 *
 * // Kept in state apart from the server, so an interrupted create still
 * // knows it. Add Alchemy.RandomProvider() to the stack's providers.
 * const random = yield* Alchemy.Random("AdminPassword", { bytes: 24 });
 * const password = Output.map(random.text, (hex) => Redacted.make(`Aa1-${Redacted.value(hex)}`));
 *
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   location: "centralus",
 *   version: "17",
 *   administratorLoginPassword: password,
 * });
 * ```
 *
 * **Example:** General Purpose server with more storage
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   version: "17",
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 *   storage: { storageSizeGB: 128, autoGrow: "Enabled" },
 * });
 * ```
 *
 * ### Databases and Parameters
 * **Example:** Create a database and set a server parameter
 * ```typescript
 * const db = yield* Azure.PostgreSQL.Database("App", {
 *   server: server.serverName,
 *   name: "app",
 * });
 * yield* Azure.PostgreSQL.Configuration("SlowLog", {
 *   server: server.serverName,
 *   name: "log_min_duration_statement",
 *   value: "500",
 * });
 * ```
 *
 * ### Firewall Rules
 * **Example:** Allow Azure services
 * ```typescript
 * // Flex Consumption Functions have no fixed outbound IP. The 0.0.0.0 rule
 * // lets Azure services in; the server still requires TLS and a password.
 * yield* Azure.PostgreSQL.FirewallRule("AllowAzureServices", {
 *   server: server.serverName,
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * **Example:** Allow an office range
 * ```typescript
 * yield* Azure.PostgreSQL.FirewallRule("Office", {
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
 *   delegations: [{ serviceName: "Microsoft.DBforPostgreSQL/flexibleServers" }],
 * });
 * const zone = yield* Azure.PrivateDns.Zone("PgZone", {
 *   name: "app.private.postgres.database.azure.com",
 * });
 * yield* Azure.PrivateDns.VirtualNetworkLink("PgZoneLink", {
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 *   network: {
 *     delegatedSubnetResourceId: subnet.subnetId,
 *     privateDnsZoneArmResourceId: zone.privateZoneId,
 *   },
 * });
 * ```
 *
 * **Example:** Turn off the public endpoint
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   network: { publicNetworkAccess: "Disabled" },
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Sign in with Microsoft Entra ID
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   authConfig: { activeDirectoryAuth: "Enabled", passwordAuth: "Enabled" },
 * });
 * yield* Azure.PostgreSQL.Administrator("Dbas", {
 *   server: server.serverName,
 *   objectId: "00000000-0000-0000-0000-000000000000", // the group's object ID
 *   principalType: "Group",
 *   principalName: "db-admins",
 * });
 * ```
 *
 * **Example:** Rotate the administrator password
 * ```diff
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 * -  administratorLoginPassword: oldPassword,
 * +  administratorLoginPassword: newPassword,
 * });
 * ```
 *
 * ### High Availability
 * **Example:** Zone-redundant standby
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 *   highAvailability: { mode: "ZoneRedundant" },
 * });
 * ```
 *
 * ### Backups and Restores
 * **Example:** Keep backups for 14 days in the paired region
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   backup: { backupRetentionDays: 14, geoRedundantBackup: "Enabled" },
 * });
 * ```
 *
 * **Example:** Restore a point in time into a new server
 * ```typescript
 * const restored = yield* Azure.PostgreSQL.FlexibleServer("Restored", {
 *   createMode: "PointInTimeRestore",
 *   sourceServerResourceId: server.serverId,
 *   pointInTimeUTC: "2026-10-24T12:00:00Z",
 * });
 * ```
 *
 * ### Read Replicas
 * **Example:** Replica with a read-write virtual endpoint
 * ```typescript
 * const replica = yield* Azure.PostgreSQL.FlexibleServer("Replica", {
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 * });
 * yield* Azure.PostgreSQL.VirtualEndpoint("Endpoints", {
 *   server: primary.serverName,
 *   members: [replica.serverName],
 * });
 * ```
 *
 * ### Maintenance
 * **Example:** Sunday 02:00 UTC maintenance window
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   maintenanceWindow: { customWindow: "Enabled", dayOfWeek: 0, startHour: 2, startMinute: 0 },
 * });
 * ```
 *
 * ### Binding to a runtime
 * PostgreSQL has no data-plane binding: the runtime connects with a
 * PostgreSQL driver over TLS. Yield an Output of the server inside the host.
 * Alchemy puts the value in the host's app settings and returns an Effect
 * that reads it at runtime. The host's identity gets no role.
 *
 * **Example:** Query with Drizzle from an Azure Function
 * ```typescript
 * // src/Api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Drizzle from "@alchemy.run/drizzle/Postgres";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 * import { database } from "./database.ts"; // { server, db, appPassword }
 * import { todos } from "./schema.ts";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: each Output becomes an app setting
 *     const { server, db: appDb, appPassword } = yield* database;
 *     const host = yield* server.fullyQualifiedDomainName;
 *     const databaseName = yield* appDb.databaseName;
 *     const password = yield* appPassword.text;
 *
 *     // runtime: build the URL from the app settings
 *     const connectionString = Effect.gen(function* () {
 *       const hostName = yield* host;
 *       const name = yield* databaseName;
 *       const secret = yield* password;
 *       return Redacted.make(
 *         `postgresql://app_user:${Redacted.value(secret)}@${hostName}:5432/${name}?sslmode=require`,
 *       );
 *     });
 *     // One connection per request, opened on the first query.
 *     const db = yield* Drizzle.Postgres(connectionString);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.select().from(todos);
 *         return yield* HttpServerResponse.json(rows);
 *       }).pipe(Effect.orDie),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * `StopServer`, `StartServer`, and `RestartServer` each assign a custom
 * role with exactly one action on this server only, to the host's managed
 * identity or, on any other host, to an Entra service principal.
 *
 * **Example:** Stop the server at night and start it in the morning
 * ```typescript
 * // init
 * const stopServer = yield* Azure.PostgreSQL.StopServer(server);
 * const startServer = yield* Azure.PostgreSQL.StartServer(server);
 *
 * // runtime: compute billing stops while stopped; Azure starts it again after 7 days
 * yield* stopServer();
 * yield* startServer();
 * // …provided with Effect.provide([Azure.PostgreSQL.StopServerHttp, Azure.PostgreSQL.StartServerHttp])
 * ```
 *
 * **Example:** Restart after a parameter change
 * ```typescript
 * // init
 * const restartServer = yield* Azure.PostgreSQL.RestartServer(server);
 *
 * // runtime
 * yield* restartServer({ restartWithFailover: false });
 * // …provided with Effect.provide(Azure.PostgreSQL.RestartServerHttp)
 * ```
 *
 * ### Deleting a Server
 * Destroying the server deletes every database on it.
 *
 * **Example:** Keep the server when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const FlexibleServer = GroupedResource<FlexibleServer>("Azure.PostgreSQL.FlexibleServer");

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
  Redacted.make(`Aa1-${Buffer.from(crypto.randomBytes(24)).toString("base64url")}`),
);

const reveal = (value: Redacted.Redacted<string> | string | undefined): string | undefined =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const lower = (value: string | undefined) => value?.toLowerCase();

/** ARM reports PostgreSQL server locations by display name (`Central US`). */
const normalizeLocation = (value: string | undefined) => value?.replace(/\s+/g, "").toLowerCase();

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

const identityInput = (identity: FlexibleServerIdentity): postgresql.UserAssignedIdentityInput => ({
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
  const want = (desired.userAssignedIdentityIds ?? []).map((id) => id.toLowerCase()).sort();
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
): Omit<postgresql.UpdateServerRequest, "subscriptionId" | "resourceGroupName" | "serverName"> => {
  const props = observed.properties ?? {};
  const properties: postgresql.ServerPropertiesForPatchInput = {};

  if (news.version !== undefined && Number(news.version) > Number(props.version ?? 0)) {
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
  if (retention !== undefined && retention !== props.backup?.backupRetentionDays) {
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

  return {
    sku: observed.sku?.name !== sku.name || observed.sku?.tier !== sku.tier ? sku : undefined,
    identity:
      news.identity !== undefined && identityDiffers(observed.identity, news.identity)
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
      const page = yield* collectAll(postgresql.ListServerBySubscription, { subscriptionId });
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
          Number(news.version) < Number(output.version)) ||
        (news.administratorLogin ?? DEFAULT_LOGIN) !==
          (before.administratorLogin ?? DEFAULT_LOGIN) ||
        (news.createMode ?? "Create") !== (before.createMode ?? "Create") ||
        news.sourceServerResourceId !== before.sourceServerResourceId ||
        news.pointInTimeUTC !== before.pointInTimeUTC ||
        news.availabilityZone !== before.availabilityZone ||
        (news.storage?.type ?? "Premium_LRS") !== (before.storage?.type ?? "Premium_LRS") ||
        (news.storage?.storageSizeGB ?? 0) < (before.storage?.storageSizeGB ?? 0) ||
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
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
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
      const label = `PostgreSQL flexible server ${name}`;
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
          yield* postgresql.StartServer(ref).pipe(Effect.retry(whileServerBusy));
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
        observed = yield* waitReplicaAttached(label, ref, news.sourceServerResourceId);
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
      yield* ignoreNotFound(postgresql.DeleteServer(ref).pipe(Effect.retry(whileServerBusy)));
      yield* waitUntilGone(`PostgreSQL flexible server ${output.serverName}`, getServer(ref), {
        interval: "10 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
