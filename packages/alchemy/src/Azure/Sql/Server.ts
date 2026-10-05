import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  /** Kind of principal. */
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
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM resource IDs of user-assigned identities. */
  userAssignedIdentityIds?: string[];
}

export interface ServerProps {
  /** Resource group the server is created in. Changing it replaces the server. */
  resourceGroup: string;
  /**
   * Globally unique server name (the `<name>.database.windows.net` DNS
   * label): 1-63 lowercase letters, digits, and hyphens, not starting or
   * ending with a hyphen. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the server.
   */
  name?: string;
  /**
   * Azure location of the server. Changing it replaces the server.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SQL administrator login. Cannot be changed after creation, so changing
   * it replaces the server. Omit it (together with the password) for an
   * Entra-only server configured via {@link ServerProps.administrators}.
   */
  administratorLogin?: string;
  /**
   * SQL administrator password. Write-only: Azure never returns it, so
   * Alchemy stores a salted fingerprint and only re-sends the password
   * when it changes.
   */
  administratorLoginPassword?: Redacted.Redacted<string>;
  /**
   * Server version.
   * @default "12.0"
   */
  version?: string;
  /**
   * Minimum TLS version accepted by the server.
   * @default "1.2"
   */
  minimalTlsVersion?: "1.0" | "1.1" | "1.2" | "1.3";
  /**
   * Whether the public endpoint accepts traffic (still subject to firewall
   * rules).
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * Restrict outbound network access to the FQDNs allowed by outbound
   * firewall rules.
   * @default Azure's default (`Disabled`)
   */
  restrictOutboundNetworkAccess?: SqlEnabledState;
  /**
   * Enable IPv6 connectivity (required for IPv6 firewall rules).
   * @default Azure's default (`Disabled`)
   */
  isIPv6Enabled?: SqlEnabledState;
  /**
   * Microsoft Entra administrator set at creation. Manage it afterwards
   * with `Azure.Sql.ServerAzureADAdministrator`.
   */
  administrators?: ServerEntraAdministrator;
  /** Managed identities assigned to the server. */
  identity?: ServerIdentity;
  /** ARM resource ID of the user-assigned identity used by default. */
  primaryUserAssignedIdentityId?: string;
  /** Key Vault key URI for customer-managed TDE encryption. */
  keyId?: string;
  /** Client ID of a multi-tenant application used for cross-tenant CMK. */
  federatedClientId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Azure SQL logical server — the endpoint, authentication boundary,
 * and firewall for Azure SQL databases and elastic pools. The server
 * itself has no compute charge.
 *
 * Deleting the server deletes every database, pool, and rule on it.
 *
 * Some subscriptions (e.g. free trials) may not create SQL servers in
 * every region. Azure accepts the request and fails it asynchronously
 * (`ProvisioningDisabled`), which surfaces as a provisioning timeout;
 * pick a region that accepts new servers.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/logical-servers
 *
 * ### Creating a Server
 * **Example:** Server with a SQL administrator
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const server = yield* Azure.Sql.Server("db", {
 *   resourceGroup: group.resourceGroupName,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: Redacted.make(password),
 * });
 * ```
 *
 * **Example:** Entra-only server
 * ```typescript
 * const server = yield* Azure.Sql.Server("db", {
 *   resourceGroup: group.resourceGroupName,
 *   administrators: {
 *     login: "dba-group",
 *     sid: dbaGroupObjectId,
 *     principalType: "Group",
 *     azureADOnlyAuthentication: true,
 *   },
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Private-only server
 * ```typescript
 * const server = yield* Azure.Sql.Server("db", {
 *   resourceGroup: group.resourceGroupName,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: Redacted.make(password),
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Server = Resource<Server>("Azure.Sql.Server");

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
    server.properties?.fullyQualifiedDomainName ??
    `${name}.database.windows.net`,
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
            : Object.fromEntries(
                identity.userAssignedIdentityIds.map((id) => [id, {}]),
              ),
      };

const identityDiffers = (
  observed: ObservedServer["identity"],
  desired: ServerIdentity,
) => {
  const observedType = (observed?.type ?? "None").replace(/\s/g, "");
  if (lower(observedType) !== lower(desired.type)) return true;
  const want = (desired.userAssignedIdentityIds ?? []).map(lower).sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map(lower)
    .sort();
  return want.join(",") !== have.join(",");
};

const waitReady = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
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
      const page = yield* sql
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.serverName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
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
      const name =
        output?.serverName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getServer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.passwordFingerprint,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.serverName ?? (yield* createDnsName(id));
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
                    azureADOnlyAuthentication:
                      news.administrators.azureADOnlyAuthentication,
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
        news.identity !== undefined &&
        identityDiffers(observed.identity, news.identity);
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
              changed[key] === undefined ||
              lower(server.properties?.[key]) === lower(changed[key]),
          ) &&
          (!tagsChanged || !tagsDiffer(server.tags, tags)) &&
          (!identityChanged ||
            news.identity === undefined ||
            !identityDiffers(server.identity, news.identity));
        observed = yield* waitForProvisioned(
          `sql server ${name}`,
          getServer(subscriptionId, resourceGroup, name),
          (server) =>
            converged(server)
              ? readyState(server.properties?.state)
              : "Updating",
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
