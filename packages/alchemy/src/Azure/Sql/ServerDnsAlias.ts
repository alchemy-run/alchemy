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
import { createDnsName, lower } from "./common.ts";
import { serverPath, type ServerScope } from "./setting.ts";

export interface ServerDnsAliasProps {
  /** Resource group of the server. Changing it replaces the alias. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the alias. */
  server: string;
  /**
   * Globally unique alias name — the `<name>.database.windows.net` DNS
   * label (lowercase letters, digits, and hyphens). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the alias.
   */
  name?: string;
}

export interface ServerDnsAlias extends Resource<
  "Azure.Sql.ServerDnsAlias",
  ServerDnsAliasProps,
  {
    /** Name of the alias. */
    dnsAliasName: string;
    /** ARM resource ID of the alias. */
    dnsAliasId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Fully qualified DNS record of the alias, e.g. `<name>.database.windows.net`. */
    azureDnsRecord: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DNS alias for an Azure SQL server — an extra
 * `<alias>.database.windows.net` name that resolves to the server. Point
 * clients at the alias and move it between servers (e.g. during disaster
 * recovery) without changing connection strings.
 *
 * Aliases cannot be tagged; Alchemy treats an alias as its own when its
 * name is the one Alchemy generated for this resource (or it was created
 * by a previous deploy).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/dns-alias-overview
 *
 * ### Creating an Alias
 * **Example:** Stable connection name for a server
 * ```typescript
 * const alias = yield* Azure.Sql.ServerDnsAlias("alias", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 * });
 * // connect to alias.azureDnsRecord
 * ```
 *
 * **Example:** Alias with an explicit name
 * ```typescript
 * yield* Azure.Sql.ServerDnsAlias("alias", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   name: "orders-db",
 * });
 * ```
 *
 * @resource
 */
export const ServerDnsAlias = Resource<ServerDnsAlias>(
  "Azure.Sql.ServerDnsAlias",
);

const getAlias = (subscriptionId: string, scope: ServerScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetServerDnsAlias({
      ...serverPath(subscriptionId, scope),
      dnsAliasName: name,
    }),
  );

const toAttrs = (
  scope: ServerScope,
  name: string,
  alias: sql.GetServerDnsAliasResponse,
): ServerDnsAlias["Attributes"] => ({
  dnsAliasName: name,
  dnsAliasId: alias.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  azureDnsRecord: alias.properties?.azureDnsRecord,
});

export const ServerDnsAliasProvider = () =>
  Provider.succeed(ServerDnsAlias, {
    stables: ["dnsAliasName", "dnsAliasId", "resourceGroup", "serverName"],

    // Aliases live inside a server; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.dnsAliasName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
      const generated = yield* createDnsName(id, 40);
      const name = output?.dnsAliasName ?? olds?.name ?? generated;
      const observed = yield* getAlias(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ServerScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
      };
      const name =
        news.name ?? output?.dnsAliasName ?? (yield* createDnsName(id, 40));
      const get = getAlias(subscriptionId, scope, name);

      // Observe, then ensure. The alias has no mutable properties.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.ServerDnsAliasesCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
          dnsAliasName: name,
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql server dns alias ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteServerDnsAlias({
          ...serverPath(subscriptionId, output),
          dnsAliasName: output.dnsAliasName,
        }),
      );
      yield* waitUntilGone(
        `sql server dns alias ${output.dnsAliasName}`,
        getAlias(subscriptionId, output, output.dnsAliasName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
