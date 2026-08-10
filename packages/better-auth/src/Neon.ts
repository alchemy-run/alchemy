import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
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

export interface NeonOptions extends SqlLayerOptions {}

// The Neon serverless Pool is pg-compatible (Better Auth's Kysely path
// duck-types it as a Postgres pool via its `connect` method) but speaks
// WebSocket instead of TCP — no `pg`, no Hyperdrive, no nodejs socket
// APIs. Loaded dynamically so the driver stays an optional peer.
const loadNeonPool = Effect.promise(
  () => import("@neondatabase/serverless"),
).pipe(
  Effect.map((mod) =>
    (mod as { default?: { Pool?: unknown } }).default?.Pool !== undefined
      ? (
          mod as unknown as {
            default: {
              Pool: new (config: {
                connectionString: string;
                max?: number;
              }) => unknown;
            };
          }
        ).default.Pool
      : (
          mod as unknown as {
            Pool: new (config: {
              connectionString: string;
              max?: number;
            }) => unknown;
          }
        ).Pool,
  ),
);

const openPool = (
  urlEffect: Effect.Effect<Redacted.Redacted<string>>,
): Effect.Effect<DirectDatabase, never, Scope.Scope> =>
  Effect.gen(function* () {
    const Pool = yield* loadNeonPool;
    const url = Redacted.value(yield* urlEffect);
    return (yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
      (pool) => Effect.promise(() => (pool as { end(): Promise<void> }).end()),
    )) as DirectDatabase;
  });

/**
 * Neon database layer for {@link BetterAuth} over Neon's serverless driver
 * (`@neondatabase/serverless`, optional peer).
 *
 * This is the optimal Workers/Lambda → Neon pairing: the driver speaks
 * WebSocket/HTTP instead of TCP, so it needs no Hyperdrive, no `pg`
 * install, and no `nodejs_compat` socket support. One pool per execution,
 * closed when the event settles.
 *
 * ```typescript
 * export const AuthDb = Neon.Project("AuthDb");
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(
 *   Effect.provide(
 *     Layer.unwrap(Effect.map(AuthDb, (db) => NeonAuth(db.connectionUri))),
 *   ),
 * )
 * ```
 *
 * For TCP access through Cloudflare Hyperdrive use `CloudflareHyperdrive`;
 * for a generic `pg` connection use `Postgres`.
 */
export const Neon = (
  url: ConnectionSource,
  options?: NeonOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const urlEffect = yield* resolveConnectionSource(url);
      const migrateSource = defaultMigrateSource(url, options?.migrate);

      return {
        provider: "postgres",
        runtime: openPool(urlEffect) as DatabaseService["runtime"],
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
                  // Apply half — open the serverless pool.
                  return openPool(urlAccessor).pipe(
                    Effect.catchDefect((cause: unknown) =>
                      Effect.fail(
                        new BetterAuthMigrationError({
                          message:
                            "Failed to connect to Neon for Better Auth schema migrations",
                          cause,
                        }),
                      ),
                    ),
                  );
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
    }),
  ) as Layer.Layer<Database>;
