import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Postgres } from "./Postgres.ts";

/**
 * Bind a {@link Postgres} service to a Railway {@link Service} and obtain
 * the Effect-native connection string for `Drizzle.Postgres` /
 * `SQL.Postgres`.
 *
 * `ConnectPostgres` is the Context tag, the type, and the callable —
 * `yield* Railway.ConnectPostgres(Db)`. Provide {@link ConnectPostgresHttp}.
 *
 * @example Bind Postgres in a Service
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Postgres";
 *
 * const conn = yield* Railway.ConnectPostgres(Db);
 * const db = yield* Drizzle.Postgres(conn.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * @binding
 * @product Railway
 * @category Storage & Databases
 */
export interface ConnectPostgres extends Binding.Service<
  ConnectPostgres,
  "Railway.ConnectPostgres",
  (postgres: Postgres) => Effect.Effect<ConnectPostgresClient>
> {}

export const ConnectPostgres = Binding.Service<ConnectPostgres>(
  "Railway.ConnectPostgres",
);

export const connectEnvKeys = (postgres: Pick<Postgres, "LogicalId">) => {
  const id = postgres.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    pooled: `RAILWAY_POSTGRES_${id}_POOLED`,
    direct: `RAILWAY_POSTGRES_${id}_DIRECT`,
  };
};

export class PostgresUrlMissing extends Data.TaggedError(
  "Railway.PostgresUrlMissing",
)<{
  name: string;
}> {}

export interface ConnectPostgresClient {
  /**
   * Private (`{name}.railway.internal`) connection string. Pass this to
   * {@link Drizzle.Postgres} or `SQL.Postgres` from a {@link Service}.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Same private URI — Railway Postgres has no PgBouncer split. Kept so
   * callers matching the Fly `ConnectPostgres` shape keep working.
   */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
}
