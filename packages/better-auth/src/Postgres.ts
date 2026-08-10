import type { RuntimeContext } from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { PoolConfig } from "pg";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

/**
 * A connection-string source:
 *
 * - a literal / `Redacted` string
 * - a resource Output (Neon `branch.connectionUri`, PlanetScale
 *   `role.connectionUrl`, Prisma `connection.databaseUrl`, ...) — bound
 *   into the host environment at deploy and read back at runtime
 * - a runtime-only Effect (Cloudflare Hyperdrive's per-invocation
 *   `connectionString`)
 */
export type ConnectionSource =
  | string
  | Redacted.Redacted<string>
  | Output.Output<string>
  | Output.Output<Redacted.Redacted<string>>
  | Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;

/**
 * The deploy-resolvable subset of {@link ConnectionSource} usable for
 * migrations — runtime-only Effects (Hyperdrive) are excluded; pass the
 * origin database URL instead.
 */
export type MigrateSource =
  | string
  | Redacted.Redacted<string>
  | Output.Output<string>
  | Output.Output<Redacted.Redacted<string>>;

export interface SqlLayerOptions {
  /**
   * Deploy-resolvable connection source for schema migrations. Defaults to
   * the layer's own `url` when that is deploy-resolvable (a literal or a
   * resource Output); a runtime-only `url` (Hyperdrive) has no default —
   * pass the origin URL here, or `false` to disable migration support.
   */
  readonly migrate?: MigrateSource | false;
  /** Extra driver pool options (`max` defaults to 1 per execution). */
  readonly pool?: Record<string, unknown>;
}

export interface PostgresOptions extends SqlLayerOptions {
  readonly pool?: Omit<PoolConfig, "connectionString">;
}

const toRedacted = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/**
 * Resolve a {@link ConnectionSource} at layer init to the runtime accessor
 * effect. Outputs are bound into the host environment (deploy) and read
 * back (runtime); Effects pass through; literals wrap.
 *
 * @internal
 */
export const resolveConnectionSource = (
  source: ConnectionSource,
): Effect.Effect<Effect.Effect<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    if (Output.isOutput(source)) {
      const accessor = yield* source;
      return Effect.map(
        accessor as Effect.Effect<string | Redacted.Redacted<string>>,
        toRedacted,
      );
    }
    if (Effect.isEffect(source)) {
      return source as Effect.Effect<Redacted.Redacted<string>>;
    }
    return Effect.succeed(toRedacted(source));
  }) as Effect.Effect<Effect.Effect<Redacted.Redacted<string>>>;

/**
 * Init-half resolution of a {@link MigrateSource}: yield the Output NOW
 * (inside the migration Action's init, where it is recorded as a capture)
 * and return the deferred accessor the apply half reads.
 *
 * @internal
 */
export const initMigrateSource = (
  source: MigrateSource,
): Effect.Effect<Effect.Effect<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    if (Output.isOutput(source)) {
      const accessor = yield* source;
      return Effect.map(
        accessor as Effect.Effect<string | Redacted.Redacted<string>>,
        toRedacted,
      );
    }
    return Effect.succeed(toRedacted(source));
  }) as Effect.Effect<Effect.Effect<Redacted.Redacted<string>>>;

/**
 * Non-secret digest of a connection source for the migration Action's
 * identity — re-runs migrations when the target database changes without
 * persisting the URL itself.
 *
 * @internal
 */
export const sourceDigest = (
  source: MigrateSource,
): string | Output.Output<string> =>
  Output.isOutput(source)
    ? Output.map(
        source as Output.Output<string | Redacted.Redacted<string>>,
        (value) =>
          djb2(typeof value === "string" ? value : Redacted.value(value)),
      )
    : djb2(typeof source === "string" ? source : Redacted.value(source));

const djb2 = (value: string): string => {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
};

/** @internal */
export const defaultMigrateSource = (
  source: ConnectionSource,
  migrate: MigrateSource | false | undefined,
): MigrateSource | undefined => {
  if (migrate === false) {
    return undefined;
  }
  if (migrate !== undefined) {
    return migrate;
  }
  // The layer's own url is a valid default only when deploy-resolvable.
  return Effect.isEffect(source) && !Output.isOutput(source)
    ? undefined
    : (source as MigrateSource);
};

const loadPg = Effect.promise(() => import("pg")).pipe(
  Effect.map((mod) =>
    (mod as { default?: { Pool?: unknown } }).default?.Pool !== undefined
      ? (mod as { default: { Pool: new (config: PoolConfig) => unknown } })
          .default.Pool
      : (mod as unknown as { Pool: new (config: PoolConfig) => unknown }).Pool,
  ),
);

/**
 * Build the Postgres {@link DatabaseService}.
 *
 * @internal
 */
export const makePostgresService = (
  source: ConnectionSource,
  options: PostgresOptions | undefined,
): Effect.Effect<DatabaseService> =>
  Effect.gen(function* () {
    const urlEffect = yield* resolveConnectionSource(source);
    const migrateSource = defaultMigrateSource(source, options?.migrate);

    const runtime = Effect.gen(function* () {
      const Pool = yield* loadPg;
      const url = Redacted.value(yield* urlEffect);
      return yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              connectionString: url,
              max: 1,
              ...options?.pool,
            }),
        ),
        (pool) =>
          Effect.promise(() => (pool as { end(): Promise<void> }).end()),
      );
    });

    return {
      provider: "postgres",
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
                  const Pool = yield* loadPg.pipe(
                    Effect.catchDefect((cause: unknown) =>
                      Effect.fail(
                        new BetterAuthMigrationError({
                          message:
                            "Failed to load `pg` — install it to migrate a Postgres-backed BetterAuth",
                          cause,
                        }),
                      ),
                    ),
                  );
                  const url = Redacted.value(yield* urlAccessor);
                  const pool = yield* Effect.acquireRelease(
                    Effect.sync(
                      () => new Pool({ connectionString: url, max: 1 }),
                    ),
                    (pool) =>
                      Effect.promise(() =>
                        (pool as { end(): Promise<void> }).end(),
                      ),
                  );
                  return pool as DirectDatabase;
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
 * Generic TCP Postgres database layer for Better Auth, from a connection
 * string.
 *
 * Works with every Postgres alchemy exposes a connection string for:
 * PlanetScale Postgres (`role.connectionUrl`), Prisma Postgres
 * (`connection.databaseUrl`), AWS RDS inside a VPC, or any literal URL.
 * One `pg.Pool` is opened per execution and closed when the event settles
 * — the only legal pooling shape on workerd. Prefer `Neon`,
 * `AuroraDataApi`, or `CloudflareHyperdrive` when they match your
 * environment → database pair.
 *
 * On AWS Lambda, add `build: { install: ["pg"] }` to the Function props so
 * the dynamically-imported driver ships in the artifact with an npm layout
 * (its CJS require chain does not survive store-style node_modules).
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer pg
 * @product Postgres
 *
 * @section Connecting with a resource Output
 * Resource Outputs are bound into the host environment at deploy and read
 * back at runtime; the same source drives deploy-time migrations.
 * @example PlanetScale Postgres
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { Postgres } from "@alchemy.run/better-auth/Postgres";
 *
 * const role = yield* Planetscale.PostgresRole("auth-role", { database, branch });
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(Postgres(role.connectionUrl)))
 * ```
 *
 * @section Separate migration source
 * When the runtime URL is not deploy-resolvable (or points at a pooler),
 * pass a direct deploy-time URL as `migrate`.
 * @example Pooled runtime, direct migrations
 * ```typescript
 * Postgres(role.connectionUrlPooled, { migrate: role.connectionUrl })
 * ```
 */
export const Postgres = (
  url: ConnectionSource,
  options?: PostgresOptions,
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    makePostgresService(url, options),
  ) as Layer.Layer<Database>;
