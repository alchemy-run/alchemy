import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Postgres } from "./Postgres.ts";

export const DATABASE_URL_ENV = "DATABASE_URL";

export const connectPostgresEnvKeys = (postgres: Pick<Postgres, "LogicalId">) => {
  const id = postgres.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    internal: `RENDER_POSTGRES_${id}_INTERNAL`,
    external: `RENDER_POSTGRES_${id}_EXTERNAL`,
    pooledInternal: `RENDER_POSTGRES_${id}_POOLED_INTERNAL`,
    pooledExternal: `RENDER_POSTGRES_${id}_POOLED_EXTERNAL`,
  } as const;
};

export class PostgresUrlMissing extends Data.TaggedError("Render.PostgresUrlMissing")<{
  readonly resourceName: string;
}> {}

export interface ConnectPostgresClient {
  /**
   * Default connection string for the host platform (Render internal private
   * network URL on Render services; external TLS URL on foreign hosts).
   */
  readonly connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Private Render internal connection string (`dpg-...-a`).
   */
  readonly internalConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Public external TLS connection string for non-Render runtimes.
   */
  readonly externalConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Pooled PgBouncer connection string (`:6432`) for the host platform when
   * `connectionPool: "pgbouncer"` is enabled on the database, falling back to
   * the direct connection string when pooling is disabled.
   */
  readonly pooledConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Private Render internal PgBouncer pooled connection string (`:6432`),
   * falling back to `internalConnectionString` when pooling is disabled.
   */
  readonly pooledInternalConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Public external PgBouncer pooled TLS connection string (`:6432`),
   * falling back to `externalConnectionString` when pooling is disabled.
   */
  readonly pooledExternalConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
}

/**
 * Bind a Render {@link Postgres} database to a Render service or foreign
 * runtime host and obtain typed PostgreSQL connection strings.
 *
 * On Render services (`WebService`, `PrivateService`, `BackgroundWorker`,
 * `CronJob`, `StaticSite`), `ConnectPostgres` binds `DATABASE_URL` and
 * `RENDER_POSTGRES_<ID>_INTERNAL` / `_EXTERNAL` into service environment
 * variables and prefers the internal connection string. On any other
 * `RuntimeContext` host, it binds the external connection string into the host's
 * runtime context. Provide {@link ConnectPostgresHttp}.
 *
 * **Example:** Connect to Render Postgres from a service
 * ```typescript
 * const dbConn = yield* Render.ConnectPostgres(mainDb);
 * ```
 *
 * @binding
 * @product Postgres
 * @category Storage & Databases
 */
export interface ConnectPostgres extends Binding.Service<
  ConnectPostgres,
  "Render.ConnectPostgres",
  (postgres: Postgres) => Effect.Effect<ConnectPostgresClient>
> {}

export const ConnectPostgres = Binding.Service<ConnectPostgres>("Render.ConnectPostgres");
