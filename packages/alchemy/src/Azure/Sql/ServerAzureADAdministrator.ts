import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";

/** The administrator resource is a singleton named `ActiveDirectory`. */
const ADMINISTRATOR_NAME = "ActiveDirectory";

export interface ServerAzureADAdministratorProps {
  /** Resource group of the server. Changing it replaces the administrator. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the administrator. */
  server: string;
  /** Display name of the user, group, or application. */
  login: string;
  /**
   * Object ID of the user or group, or the application (client) ID of a
   * service principal or managed identity.
   */
  sid: string;
  /**
   * Entra tenant of the administrator.
   * @default the subscription's tenant
   */
  tenantId?: string;
}

export interface ServerAzureADAdministrator extends Resource<
  "Azure.Sql.ServerAzureADAdministrator",
  ServerAzureADAdministratorProps,
  {
    /** ARM resource ID of the administrator. */
    administratorId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Display name of the administrator. */
    login: string;
    /** Object or application ID of the administrator. */
    sid: string;
    /** Entra tenant of the administrator. */
    tenantId: string | undefined;
    /** Whether the server only allows Microsoft Entra authentication. */
    azureADOnlyAuthentication: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * The Microsoft Entra administrator of an Azure SQL server — a user,
 * group, or service principal that can create contained database users
 * for other Entra identities.
 *
 * A server has at most one Entra administrator, so Alchemy treats an
 * existing administrator it did not set as unowned. Azure refuses to
 * remove the administrator while Entra-only authentication is enabled.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-configure
 *
 * ### Setting the Administrator
 * **Example:** Entra group as administrator
 * ```typescript
 * yield* Azure.Sql.ServerAzureADAdministrator("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   login: "dba-group",
 *   sid: dbaGroupObjectId,
 * });
 * ```
 *
 * **Example:** Managed identity as administrator
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("dba", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Sql.ServerAzureADAdministrator("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   login: identity.identityName,
 *   sid: identity.clientId,
 * });
 * ```
 *
 * @resource
 */
export const ServerAzureADAdministrator = Resource<ServerAzureADAdministrator>(
  "Azure.Sql.ServerAzureADAdministrator",
);

const getAdministrator = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerAzureADAdministrator({
      subscriptionId,
      resourceGroupName,
      serverName,
      administratorName: ADMINISTRATOR_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  admin: sql.GetServerAzureADAdministratorResponse,
): ServerAzureADAdministrator["Attributes"] => ({
  administratorId: admin.id ?? "",
  serverName,
  resourceGroup,
  login: admin.properties?.login ?? "",
  sid: admin.properties?.sid ?? "",
  tenantId: admin.properties?.tenantId,
  azureADOnlyAuthentication: admin.properties?.azureADOnlyAuthentication,
});

const matches = (
  admin: sql.GetServerAzureADAdministratorResponse,
  login: string,
  sid: string,
  tenantId: string,
) =>
  admin.properties?.login === login &&
  lower(admin.properties?.sid) === lower(sid) &&
  lower(admin.properties?.tenantId) === lower(tenantId);

export const ServerAzureADAdministratorProvider = () =>
  Provider.succeed(ServerAzureADAdministrator, {
    stables: ["administratorId", "serverName", "resourceGroup"],

    // The administrator lives inside a server; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const observed = yield* getAdministrator(
        subscriptionId,
        resourceGroup,
        serverName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, observed);
      // No tags or markers: an administrator we never set is foreign.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server, login, sid } = news;
      const tenantId = news.tenantId ?? env.tenantId;
      const get = getAdministrator(subscriptionId, resourceGroup, server);

      // Observe, then create or converge in one long-running PUT.
      const observed = yield* get;
      if (observed === undefined || !matches(observed, login, sid, tenantId)) {
        yield* sql.ServerAzureADAdministratorsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          administratorName: ADMINISTRATOR_NAME,
          properties: {
            administratorType: "ActiveDirectory",
            login,
            sid,
            tenantId,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql entra administrator on ${server}`,
        get,
        (admin) =>
          matches(admin, login, sid, tenantId) ? "Succeeded" : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, server, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteServerAzureADAdministrator({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          administratorName: ADMINISTRATOR_NAME,
        }),
      );
      yield* waitUntilGone(
        `sql entra administrator on ${output.serverName}`,
        getAdministrator(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
