import * as DO from "@distilled.cloud/digitalocean";
import type { ConnectionPool as ApiConnectionPool } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { toRedactedOrUndefined } from "../internal/redacted.ts";
import type { Providers } from "../Providers.ts";
import { clusterCaCertificate, waitUntilOnline } from "./Cluster.ts";

export type ConnectionPoolMode = "transaction" | "session" | "statement";

export type ConnectionPoolProps = {
  /** The PostgreSQL cluster. A change replaces the pool. */
  clusterId: string;
  /**
   * Pool name, also the database name clients connect to. A change replaces
   * the pool.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Database the pool serves. Updates in place. */
  database: string;
  /** User the pool connects as. Updates in place. @default the client's own user */
  user?: string;
  /** Server connections in the pool. Updates in place. */
  size: number;
  /** PgBouncer pool mode. Updates in place. @default "transaction" */
  mode?: ConnectionPoolMode;
};

export type ConnectionPool = Resource<
  "DigitalOcean.Databases.ConnectionPool",
  ConnectionPoolProps,
  {
    /** The cluster. */
    clusterId: string;
    /** Pool name. */
    name: string;
    /** Public host name of the pool. */
    host: string | undefined;
    /** Port of the pool. */
    port: number | undefined;
    /** Public connection URI of the pool. */
    uri: Redacted.Redacted<string> | undefined;
    /** Connection URI of the pool inside the VPC. */
    privateUri: Redacted.Redacted<string> | undefined;
    /** The PEM certificate of the CA that signs the cluster's TLS certificate. */
    caCertificate: string | undefined;
  },
  never,
  Providers
>;

/**
 * A PgBouncer connection pool on a PostgreSQL Managed Database cluster.
 * Runtimes that open many short connections (functions, serverless apps)
 * connect to the pool instead of the database. Everything but the name and
 * cluster updates in place.
 *
 * ### Pooling Connections
 * **Example:** A transaction pool for an app database
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const app = yield* DigitalOcean.Databases.Database("app", { clusterId: pg.clusterId });
 * const pool = yield* DigitalOcean.Databases.ConnectionPool("app-pool", {
 *   clusterId: pg.clusterId,
 *   database: app.name,
 *   size: 10,
 * });
 * // Connect to pool.uri.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/databases_add_connectionPool
 *
 * @resource
 * @product Managed Databases
 * @category Databases
 */
export const ConnectionPool = Resource<ConnectionPool>("DigitalOcean.Databases.ConnectionPool");

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 60, delimiter: "_" });

const observe = (clusterId: string, name: string) =>
  noneIfNotFound(
    DO.getDatabaseConnectionPool({ database_cluster_uuid: clusterId, pool_name: name }).pipe(
      Effect.map((r) => r.pool),
    ),
  );

const toAttrs = (clusterId: string, pool: ApiConnectionPool, caCertificate?: string) => ({
  clusterId,
  name: pool.name,
  host: pool.connection?.host,
  port: pool.connection?.port,
  uri: toRedactedOrUndefined(pool.connection?.uri),
  privateUri: toRedactedOrUndefined(pool.private_connection?.uri),
  caCertificate,
});

export const ConnectionPoolProvider = () =>
  Provider.succeed(ConnectionPool, {
    stables: ["clusterId", "name"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const clusterId = output?.clusterId ?? olds.clusterId;
      const observed = yield* observe(clusterId, name);
      return Option.getOrUndefined(
        Option.map(observed, (p) => toAttrs(clusterId, p, output?.caCertificate)),
      );
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (news.clusterId !== olds.clusterId || news.name !== olds.name) {
        return { action: "replace" } as const;
      }
      // Pools deployed before `caCertificate` existed record it on their next deploy.
      if (output !== undefined && output.caCertificate === undefined) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = output?.name ?? news.name ?? (yield* physicalName(id));
      const desired = {
        mode: news.mode ?? "transaction",
        size: news.size,
        db: news.database,
        user: news.user,
      };
      yield* waitUntilOnline(news.clusterId);
      const observed = yield* observe(news.clusterId, name);
      if (Option.isNone(observed)) {
        const { pool } = yield* DO.addDatabaseConnectionPool({
          database_cluster_uuid: news.clusterId,
          name,
          ...desired,
        });
        return toAttrs(news.clusterId, pool, yield* clusterCaCertificate(news.clusterId));
      }
      const pool = observed.value;
      const inSync =
        pool.mode === desired.mode &&
        pool.size === desired.size &&
        pool.db === desired.db &&
        (desired.user === undefined || pool.user === desired.user);
      if (!inSync) {
        yield* DO.updateDatabaseConnectionPool({
          database_cluster_uuid: news.clusterId,
          pool_name: name,
          ...desired,
        });
      }
      return toAttrs(news.clusterId, pool, yield* clusterCaCertificate(news.clusterId));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteDatabaseConnectionPool({
          database_cluster_uuid: output.clusterId,
          pool_name: output.name,
        }),
      );
    }),
  });
