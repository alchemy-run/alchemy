import * as postgresql from "@distilled.cloud/azure/postgresql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  POSTGRES_NAMESPACE,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export interface DatabaseProps {
  /**
   * Resource group of the server.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.PostgreSQL.FlexibleServer` that holds the database.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   */
  server: string;
  /**
   * Database name (case-sensitive, up to 63 characters). The built-in
   * `postgres`, `azure_maintenance`, and `azure_sys` databases cannot be
   * managed.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Character set.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default "UTF8"
   */
  charset?: string;
  /**
   * Collation, e.g. `en_US.utf8` or `C`.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default "en_US.utf8"
   */
  collation?: string;
}

export interface Database extends Resource<
  "Azure.PostgreSQL.Database",
  DatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Character set. */
    charset: string;
    /** Collation. */
    collation: string;
  },
  never,
  Providers
> {}

/**
 * A database on an Azure Database for PostgreSQL flexible server
 * (`Microsoft.DBforPostgreSQL/flexibleServers/databases`).
 *
 * Databases cannot be tagged. Alchemy treats a database as its own when its
 * server carries this stack and stage's ownership tags.
 *
 * :::caution[Changing `name`, `server`, `charset`, `collation`, or `resourceGroup` replaces the database]
 * Alchemy creates a new, empty database and drops the old one with its
 * data.
 * :::
 *
 * See [Create a database in Azure Database for PostgreSQL](https://learn.microsoft.com/azure/postgresql/flexible-server/quickstart-create-server).
 *
 * ### Creating a Database
 * **Example:** Database with the default charset and collation
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("Postgres", {
 *   location: "centralus",
 * });
 * const db = yield* Azure.PostgreSQL.Database("App", {
 *   server: server.serverName,
 *   name: "app",
 * });
 * // db.databaseName === "app"
 * ```
 *
 * **Example:** Custom collation
 * ```typescript
 * const reports = yield* Azure.PostgreSQL.Database("Reports", {
 *   server: server.serverName,
 *   collation: "C",
 * });
 * ```
 *
 * ### Binding to a runtime
 * The runtime connects with a PostgreSQL driver. Yield the host name and
 * database name inside the host to put them in its app settings, then read
 * them at runtime (see `Azure.PostgreSQL.FlexibleServer` for the whole
 * Function).
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
 * // `postgresql://<user>:<password>@${hostName}:5432/${name}?sslmode=require`
 * ```
 *
 * @resource
 */
export const Database = GroupedResource<Database>("Azure.PostgreSQL.Database");

export class ReservedDatabaseName extends Data.TaggedError(
  "Azure.PostgreSQL.ReservedDatabaseName",
)<{ readonly name: string; readonly message: string }> {}

const RESERVED = new Set(["postgres", "azure_maintenance", "azure_sys"]);
const DEFAULT_CHARSET = "UTF8";
const DEFAULT_COLLATION = "en_US.utf8";

const createDatabaseName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "_",
  });
  return name.replace(/[^a-z0-9_]/g, "_");
});

interface DatabaseRef extends ServerRef {
  readonly databaseName: string;
}

const getDatabase = (ref: DatabaseRef) => orUndefinedIfNotFound(postgresql.GetDatabase(ref));

const toAttrs = (
  ref: DatabaseRef,
  database: postgresql.GetDatabaseResponse,
): Database["Attributes"] => ({
  databaseName: ref.databaseName,
  databaseId: database.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  charset: database.properties?.charset ?? DEFAULT_CHARSET,
  collation: database.properties?.collation ?? DEFAULT_COLLATION,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseName", "databaseId", "server", "resourceGroup"],

    // Databases live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        (news.name !== undefined && news.name !== output.databaseName) ||
        !sameText(news.charset ?? DEFAULT_CHARSET, output.charset) ||
        !sameText(news.collation ?? DEFAULT_COLLATION, output.collation)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref: DatabaseRef = {
        subscriptionId,
        resourceGroupName,
        serverName,
        databaseName: output?.databaseName ?? olds?.name ?? (yield* createDatabaseName(id)),
      };
      const observed = yield* getDatabase(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const databaseName = news.name ?? output?.databaseName ?? (yield* createDatabaseName(id));
      if (RESERVED.has(databaseName)) {
        return yield* new ReservedDatabaseName({
          name: databaseName,
          message: `'${databaseName}' is a built-in database and cannot be managed`,
        });
      }
      const ref: DatabaseRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        databaseName,
      };

      // Observe; databases are existence-only (no update API).
      const observed = yield* getDatabase(ref);

      // Ensure. The PUT is a long-running operation (202 + empty body).
      if (observed === undefined) {
        yield* postgresql
          .CreateDatabase({
            ...ref,
            properties: {
              charset: news.charset ?? DEFAULT_CHARSET,
              collation: news.collation ?? DEFAULT_COLLATION,
            },
          })
          .pipe(Effect.retry(whileServerBusy));
      }
      const fresh = yield* waitForProvisioned(
        `PostgreSQL database ${databaseName}`,
        getDatabase(ref),
        () => undefined,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: DatabaseRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        databaseName: output.databaseName,
      };
      yield* ignoreNotFound(postgresql.DeleteDatabase(ref).pipe(Effect.retry(whileServerBusy)));
      yield* waitUntilGone(`PostgreSQL database ${output.databaseName}`, getDatabase(ref), {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.PostgreSQL.FlexibleServer"] },
  });
