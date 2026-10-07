import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { Client, ClientConfig, Pool, PoolConfig } from "pg";

/**
 * Lazily load the raw `pg` driver (an optional peer dependency of
 * alchemy) with a descriptive failure when it isn't installed. CJS/ESM
 * interop is normalized — callers always get the module's named surface.
 */
export const importPg = (): Promise<typeof import("pg")> =>
  import("pg")
    .then((mod) =>
      (mod as { default?: { Pool?: unknown } }).default?.Pool !== undefined
        ? (mod as unknown as { default: typeof import("pg") }).default
        : mod,
    )
    .catch((cause) => {
      throw new Error(
        "Failed to load the 'pg' driver. Install the optional peer dependency 'pg' to connect to Postgres.",
        { cause },
      );
    });

/**
 * Open a raw `pg.Pool` on the current `Scope` — `pool.end()` runs when the
 * scope closes. Pair with `makeExecutionMemo` for the one-pool-per-event
 * shape workerd and Lambda require (see `SQL/Postgres.ts` for the
 * effect-sql equivalent).
 *
 * `max` defaults to 1: per-execution pools never need more than one
 * connection.
 */
export const openPostgresPool = (
  url: Effect.Effect<Redacted.Redacted<string>>,
  config?: Omit<PoolConfig, "connectionString">,
): Effect.Effect<Pool, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pg = yield* Effect.promise(importPg);
    const connectionString = Redacted.value(yield* url);
    return yield* Effect.acquireRelease(
      Effect.sync(() => new pg.Pool({ connectionString, max: 1, ...config })),
      (pool) => Effect.promise(() => pool.end()),
    );
  });

/**
 * Strip query-string SSL flags from a connection URI so
 * `pg-connection-string` does not treat `sslmode=require` as
 * `verify-full` (and warn about it). Callers set TLS on the client via
 * the `ssl` option instead.
 */
export const stripSslQueryParams = (uri: string): string => {
  try {
    const url = new URL(uri);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return uri;
  }
};

/**
 * Open and connect a raw `pg.Client`. `onError` types every failure —
 * a missing `pg` driver as well as the connect itself.
 */
export const connectPgClient = <E>(
  config: ClientConfig,
  onError: (cause: unknown) => E,
): Effect.Effect<Client, E> =>
  Effect.tryPromise({
    try: async () => {
      const { Client } = await importPg();
      const client = new Client(config);
      await client.connect();
      return client;
    },
    catch: onError,
  });

/**
 * Acquire a client with `connect` (usually {@link connectPgClient}, possibly
 * wrapped in a retry) for the scope of `use`, closing it afterwards.
 */
export const withPgClient = <A, E, R, CE, CR>(
  connect: Effect.Effect<Client, CE, CR>,
  use: (client: Client) => Effect.Effect<A, E, R>,
): Effect.Effect<A, CE | E, R | CR> =>
  Effect.acquireUseRelease(connect, use, (client) =>
    Effect.promise(() => client.end().catch(() => {})),
  );
