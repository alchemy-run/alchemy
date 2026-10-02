import * as mysql from "@distilled.cloud/azure/mysql";
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
import {
  MYSQL_NAMESPACE,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export interface AdministratorProps {
  /** Resource group of the server. Changing it replaces the administrator. */
  resourceGroup: string;
  /**
   * Name of the flexible server. Changing it replaces the administrator.
   */
  server: string;
  /**
   * Sign-in name of the Microsoft Entra user, group, or application; it
   * becomes the MySQL user the principal signs in as.
   */
  login: string;
  /** Object ID of the Microsoft Entra principal. */
  sid: string;
  /**
   * Tenant of the principal.
   * @default the deploying subscription's tenant
   */
  tenantId?: string;
  /**
   * ARM ID of a user-assigned identity attached to the server
   * (`userAssignedIdentityIds`). The server uses it to query Microsoft
   * Graph, so it needs the `User.Read.All`, `GroupMember.Read.All`, and
   * `Application.Read.All` application permissions.
   */
  identityResourceId: string;
}

export interface Administrator extends Resource<
  "Azure.MySQL.Administrator",
  AdministratorProps,
  {
    /** ARM resource ID of the administrator. */
    administratorId: string;
    /** Sign-in name of the principal. */
    login: string;
    /** Object ID of the principal. */
    sid: string;
    /** Tenant of the principal. */
    tenantId: string;
    /** User-assigned identity the server uses to query Microsoft Graph. */
    identityResourceId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * The Microsoft Entra administrator of an Azure Database for MySQL
 * flexible server. A server has at most one Entra administrator; deleting
 * this resource removes it.
 *
 * The server must have a user-assigned identity with Microsoft Graph read
 * permissions; pass it as `identityResourceId`.
 *
 * @see https://learn.microsoft.com/azure/mysql/flexible-server/how-to-azure-ad
 *
 * ### Granting Entra Admin
 * **Example:** Make an Entra group the administrator
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("db", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const server = yield* Azure.MySQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 *   userAssignedIdentityIds: [identity.identityId],
 * });
 * const admin = yield* Azure.MySQL.Administrator("dbas", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   login: "db-admins",
 *   sid: "00000000-0000-0000-0000-000000000000",
 *   identityResourceId: identity.identityId,
 * });
 * ```
 *
 * @resource
 */
export const Administrator = Resource<Administrator>(
  "Azure.MySQL.Administrator",
);

const ADMINISTRATOR_NAME = "ActiveDirectory";

const getAdministrator = (ref: ServerRef) =>
  orUndefinedIfNotFound(
    mysql.GetAzureADAdministrator({
      subscriptionId: ref.subscriptionId,
      resourceGroupName: ref.resourceGroupName,
      serverName: ref.serverName,
      administratorName: ADMINISTRATOR_NAME,
    }),
  );

const toAttrs = (
  ref: ServerRef,
  admin: mysql.GetAzureADAdministratorResponse,
): Administrator["Attributes"] => ({
  administratorId: admin.id ?? "",
  login: admin.properties?.login ?? "",
  sid: admin.properties?.sid ?? "",
  tenantId: admin.properties?.tenantId ?? "",
  identityResourceId: admin.properties?.identityResourceId ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const AdministratorProvider = () =>
  Provider.succeed(Administrator, {
    stables: ["administratorId", "server", "resourceGroup"],

    // The administrator lives inside a server; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref = { subscriptionId, resourceGroupName, serverName };
      const observed = yield* getAdministrator(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      yield* ensureRegistered(env.subscriptionId, MYSQL_NAMESPACE);
      const ref: ServerRef = {
        subscriptionId: env.subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
      };
      const desired = {
        administratorType: "ActiveDirectory",
        login: news.login,
        sid: news.sid,
        tenantId: news.tenantId ?? env.tenantId,
        identityResourceId: news.identityResourceId,
      };
      const matches = (admin: mysql.GetAzureADAdministratorResponse) =>
        admin.properties?.login === desired.login &&
        sameText(admin.properties?.sid, desired.sid) &&
        sameText(admin.properties?.tenantId, desired.tenantId) &&
        sameText(
          admin.properties?.identityResourceId,
          desired.identityResourceId,
        );

      // Observe, then ensure + sync: the PUT is an upsert of the server's
      // single administrator.
      const observed = yield* getAdministrator(ref);
      if (observed === undefined || !matches(observed)) {
        yield* mysql
          .AzureADAdministratorsCreateOrUpdate({
            ...ref,
            administratorName: ADMINISTRATOR_NAME,
            properties: desired,
          })
          .pipe(Effect.retry(whileServerBusy));
      }
      const fresh = yield* waitForProvisioned(
        `MySQL administrator ${news.login}`,
        getAdministrator(ref),
        (admin) => (matches(admin) ? undefined : "Updating"),
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ServerRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
      };
      yield* ignoreNotFound(
        mysql
          .DeleteAzureADAdministrator({
            ...ref,
            administratorName: ADMINISTRATOR_NAME,
          })
          .pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `MySQL administrator ${output.login}`,
        getAdministrator(ref),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.MySQL.FlexibleServer"] },
  });
