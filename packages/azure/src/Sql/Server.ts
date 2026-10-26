import * as sql from "@distilled.cloud/azure/sql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
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
  createDnsName,
  getServer,
  lower,
  readyState,
  sameSecret,
  secretFingerprint,
} from "./common.ts";

export type SqlEnabledState = "Enabled" | "Disabled";

/** Microsoft Entra administrator set when the server is created. */
export interface ServerEntraAdministrator {
  /** Display name of the user, group, or application. */
  login: string;
  /** Object ID (user/group) or application (client) ID of the administrator. */
  sid: string;
  /**
   * Entra tenant of the administrator.
   * @default the subscription's tenant
   */
  tenantId?: string;
  /**
   * Kind of principal.
   * @default Azure's default (`User`)
   */
  principalType?: "User" | "Group" | "Application";
  /**
   * Allow only Microsoft Entra authentication (no SQL logins). Only applied
   * at creation; afterwards Azure manages it through a separate API.
   * @default false
   */
  azureADOnlyAuthentication?: boolean;
}

/** Managed identities assigned to the server. */
export interface ServerIdentity {
  /** Identity type. `None` removes every identity. */
  type: "None" | "SystemAssigned" | "UserAssigned" | "SystemAssigned,UserAssigned";
  /**
   * ARM resource IDs of user-assigned identities. Only used with a type
   * that includes `UserAssigned`.
   * @default []
   */
  userAssignedIdentityIds?: string[];
}

export interface ServerProps {
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
   * Globally unique server name (the `<name>.database.windows.net` DNS
   * label): 1-63 lowercase letters, digits, and hyphens, not starting or
   * ending with a hyphen.
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
   * SQL administrator login. Omit it (together with the password) for an
   * Entra-only server configured with {@link ServerProps.administrators}.
   *
   * :::caution
   * Azure cannot change the login after creation. Changing it replaces the
   * server and deletes every database on it.
   * :::
   * @default no SQL administrator (Entra-only server)
   */
  administratorLogin?: string;
  /**
   * SQL administrator password: 8-128 characters from three of upper case,
   * lower case, digits, and symbols. Write-only: Azure never returns it, so
   * Alchemy stores a salted fingerprint and re-sends the password only when
   * it changes. Changing it updates the server in place.
   * @default none (required together with `administratorLogin`)
   */
  administratorLoginPassword?: Redacted.Redacted<string>;
  /**
   * Server version. Azure offers only `12.0`.
   * @default "12.0"
   */
  version?: string;
  /**
   * Minimum TLS version accepted by the server.
   * @default "1.2"
   */
  minimalTlsVersion?: "1.0" | "1.1" | "1.2" | "1.3";
  /**
   * Whether the public endpoint accepts traffic. Firewall rules still
   * apply when it is `Enabled`. `Disabled` leaves private endpoints as the
   * only path.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * Restrict outbound connections of the server to the FQDNs allowed by
   * `Azure.Sql.OutboundFirewallRule`s.
   * @default Azure's default (`Disabled`)
   */
  restrictOutboundNetworkAccess?: SqlEnabledState;
  /**
   * Enable IPv6 connectivity (required for `Azure.Sql.IPv6FirewallRule`).
   * @default Azure's default (`Disabled`)
   */
  isIPv6Enabled?: SqlEnabledState;
  /**
   * Microsoft Entra administrator set at creation. Alchemy sends it only on
   * create; manage it afterwards with `Azure.Sql.ServerAzureADAdministrator`.
   * @default no Entra administrator
   */
  administrators?: ServerEntraAdministrator;
  /**
   * Managed identities assigned to the server. A customer-managed TDE key
   * (`keyId`) needs one.
   * @default no identity
   */
  identity?: ServerIdentity;
  /**
   * ARM resource ID of the user-assigned identity the server uses by
   * default (for example to read a customer-managed key).
   * @default none
   */
  primaryUserAssignedIdentityId?: string;
  /**
   * Key Vault key URI for customer-managed transparent data encryption
   * (TDE).
   * @default service-managed TDE keys
   */
  keyId?: string;
  /**
   * Client ID of a multi-tenant application used for cross-tenant
   * customer-managed keys.
   * @default none
   */
  federatedClientId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Server extends Resource<
  "Azure.Sql.Server",
  ServerProps,
  {
    /** Name of the server. */
    serverName: string;
    /** ARM resource ID of the server. */
    serverId: string;
    /** Resource group that holds the server. */
    resourceGroup: string;
    /** Location of the server. */
    location: string;
    /** Public DNS name, e.g. `<name>.database.windows.net`. */
    fullyQualifiedDomainName: string;
    /** Server state, e.g. `Ready`. */
    state: string | undefined;
    /** Server version. */
    version: string | undefined;
    /** SQL administrator login, if any. */
    administratorLogin: string | undefined;
    /** Minimum TLS version. */
    minimalTlsVersion: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /** Object ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Tenant of the system-assigned identity, if enabled. */
    tenantId: string | undefined;
    /** Salted fingerprint of the last administrator password Alchemy set. */
    passwordFingerprint: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SQL logical server (`Microsoft.Sql/servers`): the endpoint,
 * sign-in boundary, and firewall for Azure SQL databases and elastic pools.
 * The server has no compute charge; you pay for the databases on it.
 *
 * Alchemy creates the server in the stack's resource group with TLS 1.2 as
 * the minimum version and no firewall rules, so no client connects until
 * you add an `Azure.Sql.FirewallRule` or a private endpoint. The
 * administrator password is write-only: Alchemy keeps a salted fingerprint
 * in state and sends the password again only when it changes.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, or `administratorLogin` replaces the server]
 * Alchemy creates a new, empty server and deletes the old one with every
 * database, elastic pool, and firewall rule on it.
 * :::
 *
 * :::caution[Some subscriptions cannot create servers in every region]
 * Free-trial subscriptions often get `ProvisioningDisabled` in `eastus`.
 * Azure accepts the request and fails it later, so the deploy ends in a
 * provisioning timeout. Pick a region that accepts new servers, for
 * example `centralus`.
 * :::
 *
 * See [What is a logical server in Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/logical-servers).
 *
 * ### Creating a Server
 * **Example:** Server with a generated administrator password
 * ```typescript
 * import * as Azure from "@alchemy.run/azure";
 * import * as Alchemy from "alchemy";
 * import * as Output from "alchemy/Output";
 * import * as Redacted from "effect/Redacted";
 *
 * // Azure wants three of four character kinds. Hex has two, so add a prefix.
 * // Add Alchemy.RandomProvider() to the stack's providers.
 * const random = yield* Alchemy.Random("SqlAdminPassword", { bytes: 24 });
 * const password = Output.map(random.text, (hex) => Redacted.make(`Az!${Redacted.value(hex)}`));
 *
 * const server = yield* Azure.Sql.Server("Sql", {
 *   location: "centralus",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * // server.fullyQualifiedDomainName → "<name>.database.windows.net"
 * ```
 *
 * **Example:** Password from config
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("SQL_ADMIN_PASSWORD");
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * ```
 *
 * **Example:** Entra-only server
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administrators: {
 *     login: "dba-group",
 *     sid: "00000000-0000-0000-0000-000000000000", // the group's object ID
 *     principalType: "Group",
 *     azureADOnlyAuthentication: true,
 *   },
 * });
 * ```
 *
 * ### Authentication
 * Change `administratorLoginPassword` and deploy again to rotate the
 * password. The login stays the same, and Alchemy updates the server in
 * place.
 *
 * **Example:** Manage the Entra administrator after creation
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * yield* Azure.Sql.ServerAzureADAdministrator("SqlAdmins", {
 *   server: server.serverName,
 *   login: "dba-group",
 *   sid: "00000000-0000-0000-0000-000000000000", // the group's object ID
 * });
 * yield* Azure.Sql.ServerAzureADOnlyAuthentication("EntraOnly", {
 *   server: server.serverName,
 *   azureADOnlyAuthentication: true,
 * });
 * ```
 *
 * ### Firewall Rules
 * A new server accepts no public client. Each rule opens an IPv4 range to
 * every database on the server.
 *
 * **Example:** Allow Azure services
 * ```typescript
 * // 0.0.0.0 - 0.0.0.0 is Azure's "allow Azure services" rule. Flex
 * // Consumption Functions have no fixed outbound IP, so they need it.
 * yield* Azure.Sql.FirewallRule("AllowAzureServices", {
 *   server: server.serverName,
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * **Example:** Allow an office range
 * ```typescript
 * yield* Azure.Sql.FirewallRule("Office", {
 *   server: server.serverName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow IPv6 clients
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   isIPv6Enabled: "Enabled",
 * });
 * yield* Azure.Sql.IPv6FirewallRule("OfficeV6", {
 *   server: server.serverName,
 *   startIPv6Address: "2001:db8::",
 *   endIPv6Address: "2001:db8::ffff",
 * });
 * ```
 *
 * ### Private Networking
 * **Example:** Private-only server behind a private endpoint
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("SqlEndpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: server.serverId, groupIds: ["sqlServer"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Restrict outbound connections to one storage account
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   restrictOutboundNetworkAccess: "Enabled",
 * });
 * yield* Azure.Sql.OutboundFirewallRule("Backups", {
 *   server: server.serverName,
 *   fqdn: "backups.blob.core.windows.net",
 * });
 * ```
 *
 * ### Encryption
 * **Example:** Require TLS 1.3
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   minimalTlsVersion: "1.3",
 * });
 * ```
 *
 * **Example:** Customer-managed TDE key
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("SqlKeys");
 * // key: an Azure.KeyVault.Key that the identity may wrap and unwrap
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   identity: { type: "UserAssigned", userAssignedIdentityIds: [identity.identityId] },
 *   primaryUserAssignedIdentityId: identity.identityId,
 *   keyId: key.keyUriWithVersion,
 * });
 * ```
 *
 * ### Binding to a runtime
 * Azure SQL has no data-plane binding: the runtime connects with a SQL
 * driver. Yield an Output of the server inside the host. Alchemy puts the
 * value in the host's app settings and returns an Effect that reads it at
 * runtime. The host's identity gets no role, so the driver signs in with the
 * SQL administrator (or another SQL login).
 *
 * **Example:** Declare the server, database, and firewall rule
 * ```typescript
 * // src/resources.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Alchemy from "alchemy";
 * import * as Output from "alchemy/Output";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * export const ADMIN_LOGIN = "todoadmin";
 *
 * // Output.named gives the password a stable app-setting key.
 * export const AdminPassword = Effect.gen(function* () {
 *   const random = yield* Alchemy.Random("SqlAdminPassword", { bytes: 24 });
 *   return Output.named(
 *     Output.map(random.text, (hex) => Redacted.make(`Az!${Redacted.value(hex)}`)),
 *     "SQL_ADMIN_PASSWORD",
 *   );
 * });
 *
 * export const Sql = Effect.gen(function* () {
 *   const password = yield* AdminPassword;
 *   return yield* Azure.Sql.Server("Sql", {
 *     location: "centralus",
 *     administratorLogin: ADMIN_LOGIN,
 *     administratorLoginPassword: password,
 *   });
 * });
 *
 * export const AllowAzureServices = Effect.gen(function* () {
 *   const server = yield* Sql;
 *   return yield* Azure.Sql.FirewallRule("AllowAzureServices", {
 *     server: server.serverName,
 *     startIpAddress: "0.0.0.0",
 *     endIpAddress: "0.0.0.0",
 *   });
 * });
 *
 * export const Todos = Effect.gen(function* () {
 *   const server = yield* Sql;
 *   return yield* Azure.Sql.Database("Todos", {
 *     server: server.serverName,
 *     sku: { name: "Basic" },
 *   });
 * });
 * ```
 *
 * **Example:** Query the database from an Azure Function
 * ```typescript
 * // src/Api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as MssqlClient from "@effect/sql-mssql/MssqlClient";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 * import * as SqlClient from "effect/sql/SqlClient";
 * import { ADMIN_LOGIN, AdminPassword, AllowAzureServices, Sql, Todos } from "./resources.ts";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: bind the values the driver needs into the app settings
 *     const server = yield* Sql;
 *     const database = yield* Todos;
 *     yield* AllowAzureServices;
 *     const host = yield* server.fullyQualifiedDomainName;
 *     const databaseName = yield* database.databaseName;
 *     const passwordOutput = yield* AdminPassword;
 *     const password = yield* passwordOutput;
 *
 *     // runtime: read them back and open one pool per request
 *     const SqlLive = Layer.unwrap(
 *       Effect.gen(function* () {
 *         const resolvedHost = yield* host;
 *         const resolvedDatabase = yield* databaseName;
 *         const resolvedPassword = yield* password;
 *         return MssqlClient.layer({
 *           server: resolvedHost,
 *           database: resolvedDatabase,
 *           username: ADMIN_LOGIN,
 *           password: resolvedPassword,
 *           connectTimeout: "30 seconds",
 *         });
 *       }),
 *     );
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sql = yield* SqlClient.SqlClient;
 *         const rows = yield* sql`SELECT TOP 10 title, done FROM todos`;
 *         return yield* HttpServerResponse.json(rows);
 *       }).pipe(Effect.provide(SqlLive), Effect.orDie),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * Database actions are bindings on `Azure.Sql.Database` (`PauseDatabase`,
 * `ResumeDatabase`, `FailoverDatabase`, `ExportDatabase`,
 * `CreateRestorePoint`). A planned failover-group failover binds the group
 * and the partner server that becomes the primary. The binding assigns a
 * custom role with only `Microsoft.Sql/servers/failoverGroups/failover/action`,
 * on that failover group only.
 *
 * **Example:** Fail a failover group over to the secondary server
 * ```typescript
 * // init
 * const failover = yield* Azure.Sql.FailoverFailoverGroup(group, secondary);
 *
 * // runtime
 * yield* failover();
 * // …provided with Effect.provide(Azure.Sql.FailoverFailoverGroupHttp)
 * ```
 *
 * ### Deleting a Server
 * Destroying the server deletes every database, elastic pool, and rule on
 * it. The delete waits until Azure reports the server gone.
 *
 * **Example:** Keep the server when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * **Example:** Adopt an existing server
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * // Alchemy refuses a server without its tags unless you adopt it.
 * const server = yield* Azure.Sql.Server("Sql", {
 *   name: "contoso-sql",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * }).pipe(adopt());
 * ```
 *
 * @resource
 */
export const Server = GroupedResource<Server>("Azure.Sql.Server");

type ObservedServer = sql.GetServerResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  server: ObservedServer,
  passwordFingerprint: Redacted.Redacted<string> | undefined,
): Server["Attributes"] => ({
  serverName: name,
  serverId: server.id ?? "",
  resourceGroup,
  location: server.location,
  fullyQualifiedDomainName:
    server.properties?.fullyQualifiedDomainName ?? `${name}.database.windows.net`,
  state: server.properties?.state,
  version: server.properties?.version,
  administratorLogin: server.properties?.administratorLogin,
  minimalTlsVersion: server.properties?.minimalTlsVersion,
  publicNetworkAccess: server.properties?.publicNetworkAccess,
  principalId: server.identity?.principalId,
  tenantId: server.identity?.tenantId,
  passwordFingerprint,
  tags: userTags(server.tags),
});

const toIdentity = (identity: ServerIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentityIds === undefined
            ? undefined
            : Object.fromEntries(identity.userAssignedIdentityIds.map((id) => [id, {}])),
      };

const identityDiffers = (observed: ObservedServer["identity"], desired: ServerIdentity) => {
  const observedType = (observed?.type ?? "None").replace(/\s/g, "");
  if (lower(observedType) !== lower(desired.type)) return true;
  const want = (desired.userAssignedIdentityIds ?? []).map(lower).sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map(lower)
    .sort();
  return want.join(",") !== have.join(",");
};

const waitReady = (subscriptionId: string, resourceGroup: string, name: string) =>
  waitForProvisioned(
    `sql server ${name}`,
    getServer(subscriptionId, resourceGroup, name),
    (server) => readyState(server.properties?.state),
    { interval: "5 seconds", times: 72 },
  );

export const ServerProvider = () =>
  Provider.succeed(Server, {
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
      const page = yield* collectAll(sql.ListServers, { subscriptionId });
      return (page.value ?? []).flatMap((server) => {
        const group = resourceGroupOf(server.id);
        return hasAnyAlchemyTag(server.tags) && group !== undefined && server.name !== undefined
          ? [toAttrs(group, server.name, server, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.serverName) ||
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
        (news.administratorLogin !== undefined &&
          output.administratorLogin !== undefined &&
          news.administratorLogin !== output.administratorLogin)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.serverName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getServer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed, output?.passwordFingerprint);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.serverName ?? (yield* createDnsName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const fingerprint = yield* secretFingerprint(
        `${resourceGroup}/${name}`,
        news.administratorLoginPassword,
      );
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: name,
      };
      const desired = {
        version: news.version ?? "12.0",
        minimalTlsVersion: news.minimalTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess,
        restrictOutboundNetworkAccess: news.restrictOutboundNetworkAccess,
        isIPv6Enabled: news.isIPv6Enabled,
        primaryUserAssignedIdentityId: news.primaryUserAssignedIdentityId,
        keyId: news.keyId,
        federatedClientId: news.federatedClientId,
      };

      // Observe.
      let observed = yield* getServer(subscriptionId, resourceGroup, name);

      // Ensure. Creation is a long-running operation; the PUT carries the
      // full body including the write-only password and Entra admin.
      let passwordSent = false;
      if (observed === undefined) {
        yield* sql.ServersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(news.identity),
          properties: {
            ...desired,
            administratorLogin: news.administratorLogin,
            administratorLoginPassword: news.administratorLoginPassword,
            administrators:
              news.administrators === undefined
                ? undefined
                : {
                    administratorType: "ActiveDirectory",
                    login: news.administrators.login,
                    sid: news.administrators.sid,
                    tenantId: news.administrators.tenantId ?? env.tenantId,
                    principalType: news.administrators.principalType,
                    azureADOnlyAuthentication: news.administrators.azureADOnlyAuthentication,
                  },
          },
        });
        passwordSent = true;
      }
      observed = yield* waitReady(subscriptionId, resourceGroup, name);

      // Sync mutable aspects against the observed server; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: sql.ServerPropertiesInput = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && lower(props[key]) !== lower(value)) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        !passwordSent &&
        news.administratorLoginPassword !== undefined &&
        !sameSecret(fingerprint, output?.passwordFingerprint)
      ) {
        changed.administratorLoginPassword = news.administratorLoginPassword;
      }
      const identityChanged =
        news.identity !== undefined && identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* sql.UpdateServer({
          ...where,
          identity: identityChanged ? toIdentity(news.identity) : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        // The PATCH is asynchronous and the server keeps reporting `Ready`
        // meanwhile, so wait until the observed fields converge.
        const converged = (server: ObservedServer) =>
          (Object.keys(desired) as (keyof typeof desired)[]).every(
            (key) =>
              changed[key] === undefined || lower(server.properties?.[key]) === lower(changed[key]),
          ) &&
          (!tagsChanged || !tagsDiffer(server.tags, tags)) &&
          (!identityChanged ||
            news.identity === undefined ||
            !identityDiffers(server.identity, news.identity));
        observed = yield* waitForProvisioned(
          `sql server ${name}`,
          getServer(subscriptionId, resourceGroup, name),
          (server) => (converged(server) ? readyState(server.properties?.state) : "Updating"),
          { interval: "5 seconds", times: 72 },
        );
      }

      return toAttrs(resourceGroup, name, observed, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteServer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
        }),
      );
      yield* waitUntilGone(
        `sql server ${output.serverName}`,
        getServer(subscriptionId, output.resourceGroup, output.serverName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
