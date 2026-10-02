import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal, sameLocation } from "./common.ts";

export interface StaticSiteDatabaseConnectionProps {
  /** Resource group of the static site. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the connection. */
  staticSiteName: string;
  /**
   * Name of the connection. Static Web Apps currently serves only the
   * `default` connection. Changing it replaces the connection.
   * @default "default"
   */
  name?: string;
  /**
   * ARM ID of the database: an Azure SQL database, Cosmos DB account,
   * MySQL flexible server or PostgreSQL flexible server. Changing it
   * replaces the connection.
   */
  resourceId: string;
  /** Location of the database, e.g. `centralus`. Changing it replaces it. */
  region: string;
  /**
   * Identity used to connect: `SystemAssigned`,
   * `UserAssigned:{identityResourceId}`, or omitted to use
   * `connectionString`.
   */
  connectionIdentity?: string;
  /** Connection string of the database (when no identity is used). */
  connectionString?: string | Redacted.Redacted<string>;
}

export interface StaticSiteDatabaseConnection extends Resource<
  "Azure.Web.StaticSiteDatabaseConnection",
  StaticSiteDatabaseConnectionProps,
  {
    /** Name of the connection. */
    databaseConnectionName: string;
    /** ARM resource ID of the connection. */
    databaseConnectionId: string;
    /** Name of the static site. */
    staticSiteName: string;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** ARM ID of the database. */
    resourceId: string;
    /** Location of the database. */
    region: string;
    /** Identity used to connect, if any. */
    connectionIdentity: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A database connection of an Azure Static Web App
 * (`Microsoft.Web/staticSites/databaseConnections`) that exposes the
 * database through the site's Data API builder endpoint (`/data-api`).
 * Requires the `Standard` plan.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/database-overview
 *
 * ### Connecting a Database
 * **Example:** Azure SQL database with a connection string
 * ```typescript
 * yield* Azure.Web.StaticSiteDatabaseConnection("db", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   resourceId: database.databaseId,
 *   region: "centralus",
 *   connectionString: Redacted.make(connectionString),
 * });
 * ```
 *
 * **Example:** Cosmos DB account through the site's managed identity
 * ```typescript
 * yield* Azure.Web.StaticSiteDatabaseConnection("db", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   resourceId: account.accountId,
 *   region: account.location,
 *   connectionIdentity: "SystemAssigned",
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteDatabaseConnection =
  Resource<StaticSiteDatabaseConnection>(
    "Azure.Web.StaticSiteDatabaseConnection",
  );

type ObservedConnection = web.GetStaticSiteDatabaseConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  databaseConnectionName: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteDatabaseConnection({
      subscriptionId,
      resourceGroupName,
      name,
      databaseConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  staticSiteName: string,
  databaseConnectionName: string,
  observed: ObservedConnection,
): StaticSiteDatabaseConnection["Attributes"] => ({
  databaseConnectionName,
  databaseConnectionId: observed.id ?? "",
  staticSiteName,
  resourceGroup,
  resourceId: observed.properties?.resourceId ?? "",
  region: observed.properties?.region ?? "",
  connectionIdentity: observed.properties?.connectionIdentity,
});

export const StaticSiteDatabaseConnectionProvider = () =>
  Provider.succeed(StaticSiteDatabaseConnection, {
    stables: [
      "databaseConnectionName",
      "databaseConnectionId",
      "staticSiteName",
      "resourceGroup",
      "resourceId",
      "region",
    ],

    // Connections are removed with their static site.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName) ||
        lower(news.name ?? "default") !==
          lower(output.databaseConnectionName) ||
        lower(news.resourceId) !== lower(output.resourceId) ||
        !sameLocation(news.region, output.region)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const staticSiteName = output?.staticSiteName ?? olds?.staticSiteName;
      if (resourceGroup === undefined || staticSiteName === undefined) {
        return undefined;
      }
      const name = output?.databaseConnectionName ?? olds?.name ?? "default";
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, staticSiteName, name, observed);
      // Connections carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, staticSiteName } = news;
      const name = news.name ?? "default";
      const connectionString = reveal(news.connectionString);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        name: staticSiteName,
        databaseConnectionName: name,
      };

      // Observe, including the connection string (only `show` returns it).
      const observed = yield* orUndefinedIfNotFound(
        web.GetStaticSiteDatabaseConnectionWithDetails(where),
      );

      // Ensure + sync (synchronous PUT/PATCH) against observed state.
      if (observed === undefined) {
        yield* web.StaticSitesCreateOrUpdateDatabaseConnection({
          ...where,
          properties: {
            resourceId: news.resourceId,
            region: news.region,
            connectionIdentity: news.connectionIdentity,
            connectionString,
          },
        });
      } else if (
        lower(observed.properties?.connectionIdentity) !==
          lower(news.connectionIdentity) ||
        (connectionString !== undefined &&
          connectionString !== reveal(observed.properties?.connectionString))
      ) {
        yield* web.UpdateStaticSiteDatabaseConnection({
          ...where,
          properties: {
            connectionIdentity: news.connectionIdentity,
            connectionString,
          },
        });
      }

      const final = yield* getConnection(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        name,
      );
      return final === undefined
        ? {
            databaseConnectionName: name,
            databaseConnectionId: "",
            staticSiteName,
            resourceGroup,
            resourceId: news.resourceId,
            region: news.region,
            connectionIdentity: news.connectionIdentity,
          }
        : toAttrs(resourceGroup, staticSiteName, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteStaticSiteDatabaseConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
          databaseConnectionName: output.databaseConnectionName,
        }),
      );
      yield* waitUntilGone(
        `database connection ${output.databaseConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.databaseConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.StaticSite"],
    },
  });
