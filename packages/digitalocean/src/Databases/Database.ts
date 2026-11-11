import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  MigrationError,
  runMigrations,
  stampedOf,
  withMySqlExecutor,
  withPgExecutor,
  type MigrationsInput,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations";
import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";
import { observeCluster, waitUntilOnline } from "./Cluster.ts";

export type DatabaseProps = {
  /** The cluster that holds the database. A change replaces the database. */
  clusterId: string;
  /**
   * Database name. A change replaces the database.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * SQL migrations to apply on every deploy, for PostgreSQL and MySQL
   * clusters: a directory of `.sql` files (flat, drizzle-kit or Prisma
   * layout), `{ dir, table }`, or a Drizzle schema. Bookkeeping lives in
   * Alchemy's `__alchemy_migrations` table. They run as the cluster's
   * `doadmin` user over its public endpoint, so the deploying machine must
   * be allowed by the cluster's trusted sources.
   */
  migrations?: MigrationsInput;
};

export type Database = Resource<
  "DigitalOcean.Databases.Database",
  DatabaseProps,
  {
    /** The cluster that holds the database. */
    clusterId: string;
    /** Database name. */
    name: string;
    /** Directory of the applied SQL migrations. */
    migrationsDir: string | undefined;
    /** Migration bookkeeping table. */
    migrationsTable: string | undefined;
    /** Applied migration content hashes. */
    migrationsHashes: Record<string, string>;
  },
  never,
  Providers
>;

export type DatabaseAttributes = Database["Attributes"];

/**
 * A database in a PostgreSQL or MySQL Managed Database cluster, with
 * schema migrations applied on every deploy.
 *
 * ### Creating a Database
 * **Example:** A database in a PostgreSQL cluster
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const app = yield* DigitalOcean.Databases.Database("app", { clusterId: pg.clusterId });
 * ```
 *
 * ### Migrations
 * **Example:** Apply a directory of migrations on deploy
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const app = yield* DigitalOcean.Databases.Database("app", {
 *   clusterId: pg.clusterId,
 *   migrations: "./migrations",
 * });
 * ```
 *
 * **Example:** A MySQL database with its own bookkeeping table
 * ```typescript
 * const mysql = yield* DigitalOcean.Databases.Cluster("mysql", {
 *   engine: "mysql",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * yield* DigitalOcean.Databases.Database("shop", {
 *   clusterId: mysql.clusterId,
 *   migrations: { dir: "./migrations", table: "schema_history" },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/databases_add
 *
 * @resource
 * @product Managed Databases
 * @category Databases
 */
export const Database = Resource<Database>("DigitalOcean.Databases.Database");

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 63, delimiter: "_" });

const observe = (clusterId: string, name: string) =>
  noneIfNotFound(
    DO.getDatabase({ database_cluster_uuid: clusterId, database_name: name }).pipe(
      Effect.map((r) => r.db),
    ),
  );

/**
 * Runs `use` against a database over the cluster's public endpoint as
 * `doadmin`, with TLS verified against the cluster's own CA.
 */
const withExecutor = Effect.fn(function* <A, E, R>(
  clusterId: string,
  database: string,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) {
  const cluster = yield* waitUntilOnline(clusterId);
  const { ca } = yield* DO.getDatabaseCa({ database_cluster_uuid: clusterId });
  const connection = cluster.connection;
  const password =
    connection.password === undefined
      ? undefined
      : typeof connection.password === "string"
        ? connection.password
        : Redacted.value(connection.password);
  if (connection.host === undefined || password === undefined) {
    return yield* new MigrationError({
      message: `Database cluster ${clusterId} reports no public endpoint or admin password.`,
    });
  }
  const tls = { ca: Buffer.from(ca.certificate, "base64").toString("utf8") };
  const config = {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password,
    database,
  };
  // A new cluster's DNS name takes a moment to resolve.
  const retryConnect = {
    while: (cause: unknown) =>
      typeof (cause as { code?: unknown } | null)?.code === "string" &&
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"].includes(
        (cause as { code: string }).code,
      ),
    times: 15,
    interval: "3 seconds",
  } as const;
  return yield* cluster.engine === "mysql"
    ? withMySqlExecutor({ ...config, ssl: tls }, use, { retryConnect })
    : withPgExecutor({ ...config, ssl: tls }, use, { retryConnect });
});

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["clusterId", "name"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const clusterId = output?.clusterId ?? olds.clusterId;
      const cluster = yield* observeCluster(clusterId);
      if (Option.isNone(cluster)) return undefined;
      const db = yield* observe(clusterId, name);
      if (Option.isNone(db)) return undefined;
      return {
        clusterId,
        name,
        migrationsDir: output?.migrationsDir,
        migrationsTable: output?.migrationsTable,
        migrationsHashes: output?.migrationsHashes ?? {},
      };
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      if (news.clusterId !== olds.clusterId || name !== (output?.name ?? name)) {
        return { action: "replace" } as const;
      }
      // Pending migration files update the database in place.
      if (yield* diffMigrations({ news, output })) return { action: "update" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = output?.name ?? news.name ?? (yield* physicalName(id));
      const existing = yield* observe(news.clusterId, name);
      if (Option.isNone(existing)) {
        yield* waitUntilOnline(news.clusterId);
        yield* DO.addDatabase({ database_cluster_uuid: news.clusterId, name });
      }
      const migrationsInput = migrationsInputOf(news);
      const run = migrationsInput
        ? yield* runMigrations({
            input: migrationsInput,
            stamped: stampedOf(output),
            withExecutor: (apply) => withExecutor(news.clusterId, name, apply),
          })
        : undefined;
      return {
        clusterId: news.clusterId,
        name,
        ...migrationsAttrs({ input: migrationsInput, run, output }),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteDatabase({ database_cluster_uuid: output.clusterId, database_name: output.name }),
      );
    }),
  });
