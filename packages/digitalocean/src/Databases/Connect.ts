import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Cluster } from "./Cluster.ts";
import type { ConnectionPool } from "./ConnectionPool.ts";

export class ConnectionStringMissing extends Data.TaggedError(
  "DigitalOcean.Databases.ConnectionStringMissing",
)<{
  readonly resourceName: string;
}> {
  override get message() {
    return `The connection string of '${this.resourceName}' is not bound to this runtime.`;
  }
}

export interface ConnectClient {
  /** Public connection URI, with credentials, for `Drizzle.Postgres`, `SQL.Postgres` or any driver. */
  readonly connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    ConnectionStringMissing,
    RuntimeContext
  >;
  /** Connection URI inside the VPC, for runtimes in the same VPC. */
  readonly privateConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    ConnectionStringMissing,
    RuntimeContext
  >;
}

/**
 * Connect a runtime to a Managed Database cluster or a connection pool.
 * The connection URIs reach the host as secrets in its environment, so
 * this works from a `DigitalOcean.App` and from any other cloud's runtime.
 * Pass a `ConnectionPool` to go through PgBouncer.
 *
 * **Example:** Query Postgres from an App with Drizzle
 * ```typescript
 * const Db = DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 *
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const conn = yield* DigitalOcean.Databases.Connect(Db);
 *     const db = yield* Drizzle.Postgres(conn.connectionString);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.select().from(users);
 *         return yield* HttpServerResponse.json(rows);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Databases.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Managed Databases
 */
export interface Connect extends Binding.Service<
  Connect,
  "DigitalOcean.Databases.Connect",
  (target: Cluster | ConnectionPool) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("DigitalOcean.Databases.Connect");
