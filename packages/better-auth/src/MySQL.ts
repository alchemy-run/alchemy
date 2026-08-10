import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { Pool, PoolOptions } from "mysql2/promise";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";
import {
  defaultMigrateSource,
  initMigrateSource,
  resolveConnectionSource,
  sourceDigest,
  type ConnectionSource,
  type SqlLayerOptions,
} from "./Postgres.ts";

export interface MySQLOptions extends SqlLayerOptions {
  readonly pool?: Omit<PoolOptions, "uri">;
}

// Better Auth's Kysely path expects the `mysql2/promise` pool: it passes
// the pool itself as the MysqlDialect config, and the promise pool's
// `.pool` property is the callback pool Kysely drives.
const loadMysql = Effect.promise(() => import("mysql2/promise")).pipe(
  Effect.map((mod) =>
    (mod as { default?: { createPool?: unknown } }).default?.createPool !==
    undefined
      ? (mod as { default: { createPool: (config: PoolOptions) => Pool } })
          .default.createPool
      : (mod as unknown as { createPool: (config: PoolOptions) => Pool })
          .createPool,
  ),
);

const endPool = (pool: Pool): Effect.Effect<void> =>
  Effect.promise(() => pool.end());

/**
 * Build the MySQL {@link DatabaseService}.
 *
 * @internal
 */
export const makeMySQLService = (
  source: ConnectionSource,
  options: MySQLOptions | undefined,
): Effect.Effect<DatabaseService> =>
  Effect.gen(function* () {
    const urlEffect = yield* resolveConnectionSource(source);
    const migrateSource = defaultMigrateSource(source, options?.migrate);

    const runtime = Effect.gen(function* () {
      const createPool = yield* loadMysql;
      const url = Redacted.value(yield* urlEffect);
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          createPool({
            uri: url,
            connectionLimit: 1,
            ...options?.pool,
          }),
        ),
        endPool,
      );
    });

    return {
      provider: "mysql",
      runtime: runtime as DatabaseService["runtime"],
      ...(migrateSource === undefined
        ? {}
        : {
            migrate: {
              identity: { urlDigest: sourceDigest(migrateSource) } as Record<
                string,
                unknown
              >,
              connect: Effect.gen(function* () {
                // Init half — capture the connection-string Output.
                const urlAccessor = yield* initMigrateSource(migrateSource);
                // Apply half — load the driver and open the pool.
                return Effect.gen(function* () {
                  const createPool = yield* loadMysql.pipe(
                    Effect.catchDefect((cause: unknown) =>
                      Effect.fail(
                        new BetterAuthMigrationError({
                          message:
                            "Failed to load `mysql2` — install it to migrate a MySQL-backed BetterAuth",
                          cause,
                        }),
                      ),
                    ),
                  );
                  const url = Redacted.value(yield* urlAccessor);
                  const pool = yield* Effect.acquireRelease(
                    Effect.sync(() =>
                      createPool({ uri: url, connectionLimit: 1 }),
                    ),
                    endPool,
                  );
                  return pool as unknown as DirectDatabase;
                });
              }) as Effect.Effect<
                Effect.Effect<
                  DirectDatabase,
                  BetterAuthMigrationError,
                  Scope.Scope
                >,
                never,
                RuntimeContext
              >,
            },
          }),
    } satisfies DatabaseService;
  }) as Effect.Effect<DatabaseService>;

/**
 * Generic TCP MySQL database layer for Better Auth, from a connection
 * string.
 *
 * Works with PlanetScale MySQL, Cloudflare Hyperdrive MySQL origins, AWS
 * RDS MySQL, or any literal URL. One `mysql2` pool per execution, closed
 * when the event settles.
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer mysql2
 * @product MySQL
 *
 * @section Connecting to PlanetScale MySQL
 * PlanetScale requires TLS — pass it in the URL's `ssl` query parameter
 * (mysql2 parses it as JSON).
 * @example PlanetScale MySQL with TLS
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { MySQL } from "@alchemy.run/better-auth/MySQL";
 *
 * const password = yield* Planetscale.MySQLPassword("auth-db", {
 *   database,
 *   role: "admin",
 * });
 * const url =
 *   `mysql://${password.username}:...@${password.host}/${database.name}` +
 *   `?ssl=${encodeURIComponent('{"rejectUnauthorized":true}')}`;
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(MySQL(url)))
 * ```
 */
export const MySQL = (
  url: ConnectionSource,
  options?: MySQLOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    makeMySQLService(url, options),
  ) as Layer.Layer<Database>;
