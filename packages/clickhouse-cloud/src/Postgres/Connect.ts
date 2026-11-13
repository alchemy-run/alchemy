import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { Service } from "./Service.ts";

/** How a host reaches a Postgres service. Reading these opens no connection. */
export interface PostgresConnection {
  /** `postgresql://` URL with the superuser's credentials and `sslmode=verify-full`. */
  connectionString: Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext>;
  /** Host name; Postgres listens on 5432, PgBouncer on 6432. */
  hostname: Effect.Effect<string | undefined, never, RuntimeContext>;
  /** Superuser name. */
  username: Effect.Effect<string | undefined, never, RuntimeContext>;
  /** Superuser password. */
  password: Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext>;
  /** PEM CA certificates to verify the server with. */
  caCertificates: Effect.Effect<string | undefined, never, RuntimeContext>;
}

/**
 * Connect to a ClickHouse Cloud Postgres service from any host: the
 * connection string, host name, user, password and CA certificates reach
 * the host through `RuntimeContext` (secrets stay `Redacted`), and the host
 * connects with its own driver (`pg`, `postgres`, `SQL.Postgres`).
 *
 * The Postgres API exposes only the superuser, so the host connects as the
 * superuser. For a narrower database role, create it with `migrations` and
 * pass its credentials yourself.
 *
 * ### Querying Postgres
 * **Example:** A query per request from a Worker
 * ```typescript
 * export const AppDb = ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.medium",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const db = yield* ClickHouseCloud.Postgres.Connect(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* db.connectionString;
 *         // The server's certificate is signed by the service's own CA.
 *         const ca = yield* db.caCertificates;
 *         const sql = yield* SQL.Postgres({ url: url!, ssl: { ca } });
 *         return yield* HttpServerResponse.json(yield* sql`SELECT 1 AS ok`);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.ConnectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface Connect extends Binding.Service<
  Connect,
  "ClickHouseCloud.Postgres.Connect",
  (target: Service) => Effect.Effect<PostgresConnection>
> {}

export const Connect = Binding.Service<Connect>("ClickHouseCloud.Postgres.Connect");

/** {@link Connect} through the host's `RuntimeContext`; works on any host. */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (target: Service) {
    return {
      connectionString: yield* target.connectionString,
      hostname: yield* target.hostname,
      username: yield* target.username,
      password: yield* target.password,
      caCertificates: yield* target.caCertificates,
    };
  }),
);
