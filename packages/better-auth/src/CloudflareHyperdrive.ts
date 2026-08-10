import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Database } from "./Database.ts";
import { makeMySQLService, type MySQLOptions } from "./MySQL.ts";
import {
  makePostgresService,
  type MigrateSource,
  type PostgresOptions,
} from "./Postgres.ts";

export interface CloudflareHyperdriveOptions {
  /**
   * Origin dialect behind the Hyperdrive connection.
   * @default "postgres"
   */
  readonly dialect?: "postgres" | "mysql";
  /**
   * Deploy-resolvable ORIGIN connection source for schema migrations.
   * Hyperdrive's own connection string is minted per-invocation inside the
   * Worker and cannot be used at deploy time — pass the origin database URL
   * (e.g. Neon `branch.connectionUri`) or leave unset to skip migrations.
   */
  readonly migrate?: MigrateSource;
  readonly pool?: PostgresOptions["pool"] | MySQLOptions["pool"];
}

/**
 * Cloudflare Hyperdrive layer for {@link BetterAuth} — pooled Postgres (or
 * MySQL) through a Hyperdrive {@link Cloudflare.Hyperdrive.Connection}.
 *
 * Provide it on the Worker impl effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ ... });
 *   return { fetch: ... };
 * }).pipe(
 *   Effect.provide(
 *     CloudflareHyperdrive(Hyperdrive, {
 *       migrate: branch.connectionUri, // origin URL for deploy-time schema
 *     }),
 *   ),
 * )
 * ```
 */
export const CloudflareHyperdrive = (
  connection:
    | Cloudflare.Hyperdrive.Connection
    | Effect.Effect<Cloudflare.Hyperdrive.Connection, never, any>,
  options?: CloudflareHyperdriveOptions,
) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const conn = Effect.isEffect(connection)
        ? yield* connection as Effect.Effect<Cloudflare.Hyperdrive.Connection>
        : connection;
      const client = yield* Cloudflare.Hyperdrive.Connect(conn);
      const source = client.connectionString as Effect.Effect<
        Redacted.Redacted<string>,
        never,
        RuntimeContext
      >;
      return options?.dialect === "mysql"
        ? yield* makeMySQLService(source, {
            migrate: options?.migrate ?? false,
            pool: options?.pool as MySQLOptions["pool"],
          })
        : yield* makePostgresService(source, {
            migrate: options?.migrate ?? false,
            pool: options?.pool as PostgresOptions["pool"],
          });
    }),
  ).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
