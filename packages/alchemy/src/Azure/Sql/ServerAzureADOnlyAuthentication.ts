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
import { isServerOwnedByStack, lower } from "./common.ts";

/** The setting is a singleton named `Default`. */
const AUTHENTICATION_NAME = "Default";

export interface ServerAzureADOnlyAuthenticationProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /**
   * Whether the server only accepts Microsoft Entra authentication (SQL
   * logins are rejected). Requires a `ServerAzureADAdministrator`.
   * @default true
   */
  azureADOnlyAuthentication?: boolean;
}

export interface ServerAzureADOnlyAuthentication extends Resource<
  "Azure.Sql.ServerAzureADOnlyAuthentication",
  ServerAzureADOnlyAuthenticationProps,
  {
    /** ARM resource ID of the setting. */
    authenticationId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Whether the server only accepts Microsoft Entra authentication. */
    azureADOnlyAuthentication: boolean;
  },
  never,
  Providers
> {}

/**
 * Microsoft Entra-only authentication for an Azure SQL server. When
 * enabled, SQL authentication (the server administrator login and
 * contained SQL users) is disabled and only Entra identities can connect.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource turns Entra-only authentication off again. Azure requires a
 * Microsoft Entra administrator before it can be enabled, and refuses to
 * remove that administrator while it is enabled — pass the administrator's
 * `serverName` as `server` so the setting is removed first.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/authentication-azure-ad-only-authentication
 *
 * ### Enforcing Entra Authentication
 * **Example:** Disable SQL authentication
 * ```typescript
 * const admin = yield* Azure.Sql.ServerAzureADAdministrator("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   login: identity.identityName,
 *   sid: identity.clientId,
 * });
 * yield* Azure.Sql.ServerAzureADOnlyAuthentication("entra-only", {
 *   resourceGroup: group.resourceGroupName,
 *   server: admin.serverName,
 * });
 * ```
 *
 * **Example:** Explicitly allow SQL authentication
 * ```typescript
 * yield* Azure.Sql.ServerAzureADOnlyAuthentication("entra-only", {
 *   resourceGroup: group.resourceGroupName,
 *   server: admin.serverName,
 *   azureADOnlyAuthentication: false,
 * });
 * ```
 *
 * @resource
 */
export const ServerAzureADOnlyAuthentication =
  Resource<ServerAzureADOnlyAuthentication>(
    "Azure.Sql.ServerAzureADOnlyAuthentication",
  );

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerAzureADOnlyAuthentication({
      subscriptionId,
      resourceGroupName,
      serverName,
      authenticationName: AUTHENTICATION_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  setting: sql.GetServerAzureADOnlyAuthenticationResponse,
): ServerAzureADOnlyAuthentication["Attributes"] => ({
  authenticationId: setting.id ?? "",
  serverName,
  resourceGroup,
  azureADOnlyAuthentication:
    setting.properties?.azureADOnlyAuthentication ?? false,
});

export const ServerAzureADOnlyAuthenticationProvider = () =>
  Provider.succeed(ServerAzureADOnlyAuthentication, {
    stables: ["authenticationId", "serverName", "resourceGroup"],

    // A per-server singleton setting; it disappears with its server.
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
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        serverName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const desired = news.azureADOnlyAuthentication ?? true;
      const get = getSetting(subscriptionId, resourceGroup, server);

      // Observe; the setting always exists, so only write a drift.
      const observed = yield* get;
      if (
        (observed?.properties?.azureADOnlyAuthentication ?? false) !== desired
      ) {
        yield* sql.ServerAzureADOnlyAuthenticationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          authenticationName: AUTHENTICATION_NAME,
          properties: { azureADOnlyAuthentication: desired },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql entra-only authentication on ${server}`,
        get,
        (setting) =>
          (setting.properties?.azureADOnlyAuthentication ?? false) === desired
            ? "Succeeded"
            : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, server, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // DELETE resets the singleton to `false` (it is never removed).
      yield* ignoreNotFound(
        sql.DeleteServerAzureADOnlyAuthentication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          authenticationName: AUTHENTICATION_NAME,
        }),
      );
      yield* waitUntilGone(
        `sql entra-only authentication on ${output.serverName}`,
        getSetting(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
        ).pipe(
          Effect.map((setting) =>
            setting?.properties?.azureADOnlyAuthentication
              ? setting
              : undefined,
          ),
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { singleton: true },
  });
