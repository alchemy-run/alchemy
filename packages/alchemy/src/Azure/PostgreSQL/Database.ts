import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  POSTGRES_NAMESPACE,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export interface DatabaseProps {
  /** Resource group of the server. Changing it replaces the database. */
  resourceGroup: string;
  /** Name of the flexible server. Changing it replaces the database. */
  server: string;
  /**
   * Database name (case-sensitive, up to 63 characters). If omitted, a
   * unique name is generated from the app, stage, and logical ID. The
   * built-in `postgres`, `azure_maintenance`, and `azure_sys` databases
   * cannot be managed. Changing it replaces the database.
   */
  name?: string;
  /**
   * Character set. Changing it replaces the database.
   * @default "UTF8"
   */
  charset?: string;
  /**
   * Collation. Changing it replaces the database.
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
 * A database on an Azure Database for PostgreSQL flexible server.
 *
 * Databases cannot be tagged; Alchemy treats a database as its own when its
 * server carries this stack and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/quickstart-create-server
 *
 * ### Creating a Database
 * **Example:** Database with the default charset and collation
 * ```typescript
 * const server = yield* Azure.PostgreSQL.FlexibleServer("db", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const app = yield* Azure.PostgreSQL.Database("app", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   name: "app",
 * });
 * ```
 *
 * **Example:** Custom collation
 * ```typescript
 * const reports = yield* Azure.PostgreSQL.Database("reports", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   collation: "C",
 * });
 * ```
 *
 * @resource
 */
export const Database = Resource<Database>("Azure.PostgreSQL.Database");

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

const getDatabase = (ref: DatabaseRef) =>
  orUndefinedIfNotFound(postgresql.GetDatabase(ref));

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
        databaseName:
          output?.databaseName ?? olds?.name ?? (yield* createDatabaseName(id)),
      };
      const observed = yield* getDatabase(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const databaseName =
        news.name ?? output?.databaseName ?? (yield* createDatabaseName(id));
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
      yield* ignoreNotFound(
        postgresql.DeleteDatabase(ref).pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `PostgreSQL database ${output.databaseName}`,
        getDatabase(ref),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.PostgreSQL.FlexibleServer"] },
  });
