import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { Pool } from "pg";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import type { ReplacedResourceState } from "./ResourceState.ts";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

/**
 * The subset of a `pg` `Pool` the Postgres state store uses. Any pool-shaped
 * client that can run parameterized queries and hand out a dedicated
 * connection (for the session-scoped advisory lock) satisfies it.
 */
// `pg` is an optional peer dependency — loaded lazily so importing this
// module never requires the driver; only `postgresState({ dsn })` (which
// constructs a Pool) does. A caller-supplied `client` needs no driver.
const importPg = () =>
  import("pg").catch((cause) => {
    throw new Error(
      "Failed to load the 'pg' driver. Install the optional peer dependency 'pg' to use postgresState with a `dsn`.",
      { cause },
    );
  });

export interface PostgresStateClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PostgresStateConnection>;
}

/**
 * A dedicated connection checked out from the pool. It holds the
 * session-scoped advisory lock for a `(stack, stage)` pair for the whole
 * lifetime of the state layer.
 */
export interface PostgresStateConnection {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

export interface PostgresStateOptions {
  /**
   * An existing `pg` connection pool (or a compatible client). The caller
   * owns its lifecycle — the store only issues queries against it. Exactly
   * one of `client` and `dsn` must be provided.
   */
  client?: PostgresStateClient;
  /**
   * Postgres connection string. The store creates its own `pg` pool from it
   * and closes that pool when the state layer is released.
   */
  dsn?: string;
  /**
   * Prefix for the advisory-lock key. The full key for a stack/stage is
   * `{lockKeyPrefix}:{stack}/{stage}`.
   *
   * @default "alchemy"
   */
  lockKeyPrefix?: string;
  /**
   * State-store id reported in telemetry (`alchemy.state_store.id`).
   *
   * @default "postgres"
   */
  id?: string;
  /**
   * How long (in milliseconds) a passing lease check is trusted before the
   * next state operation re-verifies the advisory lock. A lease lost inside
   * the window is detected within this many milliseconds rather than
   * instantly; in exchange, a burst of state operations does one lock
   * round-trip instead of one per operation.
   *
   * @default 5000
   */
  leaseCheckTtlMs?: number;
}

const DEFAULT_LEASE_CHECK_TTL_MS = 5_000;

/**
 * Amortizes a lease check over a short TTL: a passing check is trusted for
 * `ttlMs`, so a burst of operations inside the window does one round-trip,
 * not one per operation. A failing check is never cached — it propagates
 * immediately and leaves the last-good timestamp untouched, so the very
 * next operation re-checks.
 */
const amortizeCheck = (
  checkLive: Effect.Effect<void, StateStoreError>,
  ttlMs: number,
): Effect.Effect<void, StateStoreError> => {
  let lastOkAt: number | undefined;
  return Effect.suspend(() => {
    if (lastOkAt !== undefined && Date.now() - lastOkAt < ttlMs) {
      return Effect.void;
    }
    return checkLive.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastOkAt = Date.now();
        }),
      ),
    );
  });
};

interface Lease {
  readonly checkLive: Effect.Effect<void, StateStoreError>;
}

/**
 * State store backed by any Postgres database.
 *
 * Stack state lives in two tables — `alchemy_resource_state` and
 * `alchemy_stack_output` — created on first use with
 * `create table if not exists`.
 *
 * Concurrent deploys are serialized with a session-scoped Postgres advisory
 * lock per `(stack, stage)`: the lock is taken on a dedicated pooled
 * connection when the first operation for the pair runs, and contention
 * fails immediately instead of queueing. Every subsequent operation first
 * re-verifies — from a *different* pool connection, by inspecting
 * `pg_locks` — that the backend which took the lock still holds it, so a
 * dropped lock connection fails loudly instead of letting operations run
 * unlocked. If the process crashes, Postgres releases the session lock when
 * the connection drops; no recovery bookkeeping is needed.
 *
 * @section Using the Postgres State Store
 * @example Connection string
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import { postgresState } from "alchemy/State/PostgresState";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: myProviders(),
 *     state: postgresState({ dsn: process.env.STATE_DATABASE_URL! }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @example Caller-owned pool
 * ```typescript
 * import { Pool } from "pg";
 *
 * const pool = new Pool({ connectionString: dsn });
 * const state = postgresState({ client: pool, lockKeyPrefix: "my-app" });
 * ```
 */
export const postgresState = (options: PostgresStateOptions) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;

      const make = makePostgresState(options, scope).pipe(recordStateStoreInit);

      return yield* Effect.cached(make);
    }),
  );

/**
 * Construct a Postgres-backed {@link StateService}.
 *
 * Construction itself never touches the database — pool creation (when a
 * `dsn` was given), schema migration, and advisory-lock acquisition are all
 * deferred to the first state operation. Finalizers for the advisory locks
 * and any store-owned pool are registered on `scope`.
 */
export const makePostgresState = (
  options: PostgresStateOptions,
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const prefix = options.lockKeyPrefix ?? "alchemy";
    const ttlMs = options.leaseCheckTtlMs ?? DEFAULT_LEASE_CHECK_TTL_MS;

    const toError = (cause: unknown): StateStoreError =>
      cause instanceof StateStoreError
        ? cause
        : new StateStoreError({
            message:
              cause instanceof Error
                ? cause.message
                : `Postgres state store error: ${String(cause)}`,
            cause: cause instanceof Error ? cause : undefined,
          });

    const attempt = <A>(
      f: () => Promise<A>,
    ): Effect.Effect<A, StateStoreError> =>
      Effect.tryPromise({ try: f, catch: toError });

    /**
     * Idempotent schema migration. Concurrent `create table if not exists`
     * statements can still collide inside Postgres on the shared catalog
     * rows (duplicate pg_type/pg_class key errors), so the migration runs
     * on one dedicated connection inside a transaction that first takes a
     * transaction-scoped advisory lock on a fixed migration key. The lock
     * releases automatically at commit or rollback.
     */
    const migrate = (client: PostgresStateClient) =>
      Effect.gen(function* () {
        const conn = yield* attempt(() => client.connect());
        const releaseConn = Effect.sync(() => {
          try {
            conn.release();
          } catch {
            // The pool may already be closed; nothing left to release.
          }
        });
        yield* Effect.gen(function* () {
          yield* attempt(() => conn.query("begin"));
          yield* attempt(() =>
            conn.query(
              "select pg_advisory_xact_lock(hashtextextended($1, 0))",
              [`${prefix}:schema`],
            ),
          );
          yield* attempt(() =>
            conn.query(`
              create table if not exists alchemy_resource_state (
                stack text not null,
                stage text not null,
                fqn text not null,
                value jsonb not null,
                updated_at timestamptz not null default now(),
                primary key (stack, stage, fqn)
              )
            `),
          );
          yield* attempt(() =>
            conn.query(`
              create table if not exists alchemy_stack_output (
                stack text not null,
                stage text not null,
                value jsonb not null,
                updated_at timestamptz not null default now(),
                primary key (stack, stage)
              )
            `),
          );
          yield* attempt(() => conn.query("commit"));
        }).pipe(
          Effect.tapError(() =>
            attempt(() => conn.query("rollback")).pipe(Effect.ignore),
          ),
          Effect.ensuring(releaseConn),
        );
      });

    // Nothing touches the database at layer construction time. The client
    // is resolved (or created from the DSN) and the schema migrated inside
    // this cached Effect, which runs once on the first state operation.
    const ready = yield* Effect.cached(
      Effect.gen(function* () {
        if ((options.client === undefined) === (options.dsn === undefined)) {
          return yield* Effect.fail(
            new StateStoreError({
              message:
                "postgresState requires exactly one of `client` or `dsn`",
            }),
          );
        }
        const client: PostgresStateClient =
          options.client ??
          (yield* Effect.gen(function* () {
            const { Pool } = yield* Effect.tryPromise({
              try: importPg,
              catch: (cause) =>
                new StateStoreError({
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                }),
            });
            const pool = new Pool({ connectionString: options.dsn });
            yield* Scope.addFinalizer(
              scope,
              attempt(() => pool.end()).pipe(Effect.ignore),
            );
            return pool;
          }));
        yield* migrate(client);
        return client;
      }),
    );

    const run = <A>(
      f: (client: PostgresStateClient) => Promise<A>,
    ): Effect.Effect<A, StateStoreError> =>
      ready.pipe(Effect.flatMap((client) => attempt(() => f(client))));

    const lockKey = (stack: string, stage: string) =>
      `${prefix}:${stack}/${stage}`;

    /**
     * Acquires the session-scoped advisory lock for `key` on a dedicated
     * connection checked out from the pool. Session (not transaction)
     * scope, because a deploy spans many commits. Contention fails
     * immediately rather than queueing.
     */
    const acquireLease = (key: string): Effect.Effect<Lease, StateStoreError> =>
      Effect.gen(function* () {
        const client = yield* ready;
        const reserved = yield* attempt(() => client.connect());
        const releaseReserved = (destroy?: boolean) =>
          Effect.sync(() => {
            try {
              reserved.release(destroy);
            } catch {
              // The pool may already be closed; nothing left to release.
            }
          });
        const acquired = yield* attempt(() =>
          reserved.query(
            "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired, pg_backend_pid() as pid",
            [key],
          ),
        ).pipe(
          Effect.map((result) => result.rows[0]),
          Effect.tapError(() => releaseReserved(true)),
        );
        if (acquired?.acquired !== true) {
          yield* releaseReserved();
          return yield* Effect.fail(
            new StateStoreError({
              message: `another deploy holds the Postgres state lock '${key}'`,
            }),
          );
        }
        const lockPid = Number(acquired.pid);

        yield* Scope.addFinalizer(
          scope,
          attempt(() =>
            reserved.query(
              "select pg_advisory_unlock(hashtextextended($1, 0))",
              [key],
            ),
          ).pipe(
            // If the connection already dropped, Postgres auto-released the
            // session-scoped lock; there is nothing left to unlock.
            Effect.ignore,
            Effect.andThen(releaseReserved()),
          ),
        );

        // Deliberately verifies from a DIFFERENT pool connection, never the
        // reserved one: once the reserved connection's backend has been
        // killed server-side, querying it cannot answer reliably. Asking
        // another connection whether the backend pid captured at acquire
        // time still holds this advisory lock in `pg_locks` gives the same
        // answer (a dead or reused backend cannot hold the lock) without
        // touching the connection that might be dead.
        const checkLive = attempt(() =>
          client.query(
            `
              select exists (
                select 1 from pg_locks
                where locktype = 'advisory'
                  and pid = $2
                  and objsubid = 1
                  and granted
                  -- pg_locks splits the 64-bit advisory key into two
                  -- int4 halves; reassembling them with << 32 relies on
                  -- bigint wraparound matching hashtextextended's signed
                  -- 64-bit result, which is exact for all inputs.
                  and ((classid::bigint << 32) | (objid::bigint & 4294967295))
                    = hashtextextended($1, 0)
              ) as live
            `,
            [key, lockPid],
          ),
        ).pipe(
          Effect.flatMap((result) =>
            result.rows[0]?.live === true
              ? Effect.void
              : Effect.fail(
                  new StateStoreError({
                    message: `the Postgres state lock '${key}' was lost mid-run; refusing to continue unlocked`,
                  }),
                ),
          ),
        );

        return { checkLive: amortizeCheck(checkLive, ttlMs) };
      });

    // One lease per (stack, stage), acquired lazily on the first operation
    // that touches the pair and cached for the store's lifetime. The mutex
    // makes acquisition single-flight so two concurrent first operations
    // cannot race each other into a self-inflicted contention failure.
    const leaseMutex = Semaphore.makeUnsafe(1);
    const leases = new Map<string, Effect.Effect<Lease, StateStoreError>>();

    const leaseFor = (
      stack: string,
      stage: string,
    ): Effect.Effect<Lease, StateStoreError> =>
      Semaphore.withPermits(
        leaseMutex,
        1,
      )(
        Effect.gen(function* () {
          const key = lockKey(stack, stage);
          const existing = leases.get(key);
          if (existing !== undefined) return existing;
          const cached = yield* Effect.cached(acquireLease(key));
          leases.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((lease) => lease));

    /**
     * Every storage operation on a `(stack, stage)` first ensures this
     * store holds the pair's advisory lock and that the lease is still
     * live. Reads are guarded too, not just writes: a lost lease means a
     * concurrent deploy may already be mutating these rows, so a read could
     * return stale or conflicting data.
     */
    const guarded = <A>(
      request: { stack: string; stage: string },
      op: Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> =>
      leaseFor(request.stack, request.stage).pipe(
        Effect.flatMap((lease) => lease.checkLive),
        Effect.andThen(op),
      );

    // Operations without a stage cannot name a single lease, so they
    // re-verify every lease this store currently holds instead.
    const verifyHeldLeases: Effect.Effect<void, StateStoreError> =
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(leases.values()),
          (lease) => lease.pipe(Effect.flatMap((held) => held.checkLive)),
          { discard: true },
        ),
      );

    const jsonParam = (value: unknown) => JSON.stringify(encodeState(value));

    const deleteStage = (stack: string, stage: string) =>
      run((client) =>
        client.query(
          "delete from alchemy_resource_state where stack = $1 and stage = $2",
          [stack, stage],
        ),
      ).pipe(
        Effect.andThen(
          run((client) =>
            client.query(
              "delete from alchemy_stack_output where stack = $1 and stage = $2",
              [stack, stage],
            ),
          ),
        ),
        Effect.asVoid,
      );

    const service: StateService = {
      id: options.id ?? "postgres",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        verifyHeldLeases.pipe(
          Effect.andThen(
            run((client) =>
              client.query(
                "select stack from alchemy_resource_state union select stack from alchemy_stack_output order by stack",
              ),
            ),
          ),
          Effect.map((result) => result.rows.map((row) => String(row.stack))),
        ),
      listStages: (stack) =>
        verifyHeldLeases.pipe(
          Effect.andThen(
            run((client) =>
              client.query(
                "select stage from alchemy_resource_state where stack = $1 union select stage from alchemy_stack_output where stack = $1 order by stage",
                [stack],
              ),
            ),
          ),
          Effect.map((result) => result.rows.map((row) => String(row.stage))),
        ),
      get: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              "select value from alchemy_resource_state where stack = $1 and stage = $2 and fqn = $3",
              [request.stack, request.stage, request.fqn],
            ),
          ).pipe(
            Effect.map((result) => {
              const row = result.rows[0];
              // Every row was written by `set` through `encodeState`, so
              // reviving it recovers a PersistedState by construction.
              return row === undefined
                ? undefined
                : (reviveStateRecursive(row.value) as PersistedState);
            }),
          ),
        ),
      // Filters by status directly in SQL rather than listing FQNs and
      // re-fetching each one — same semantics as LocalState, without the
      // N+1 round-trips.
      getReplacedResources: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              "select value from alchemy_resource_state where stack = $1 and stage = $2 and value ->> 'status' = 'replaced'",
              [request.stack, request.stage],
            ),
          ).pipe(
            Effect.map((result) =>
              result.rows.map(
                (row) =>
                  reviveStateRecursive(row.value) as ReplacedResourceState,
              ),
            ),
          ),
        ),
      set: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              `
                insert into alchemy_resource_state (stack, stage, fqn, value, updated_at)
                values ($1, $2, $3, $4::jsonb, now())
                on conflict (stack, stage, fqn) do update
                  set value = excluded.value, updated_at = excluded.updated_at
              `,
              [
                request.stack,
                request.stage,
                request.fqn,
                jsonParam(request.value),
              ],
            ),
          ).pipe(Effect.map(() => request.value)),
        ),
      delete: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              "delete from alchemy_resource_state where stack = $1 and stage = $2 and fqn = $3",
              [request.stack, request.stage, request.fqn],
            ),
          ).pipe(Effect.asVoid),
        ),
      // Deleting a whole stack first acquires the advisory lock for every
      // stage it is about to remove, so a concurrent deploy of any stage
      // fails the lock instead of racing the delete. The stack-wide sweep
      // that follows runs while all of those stage locks are still held.
      deleteStack: ({ stack, stage }) =>
        stage === undefined
          ? verifyHeldLeases.pipe(
              Effect.andThen(service.listStages(stack)),
              Effect.flatMap((stages) =>
                Effect.forEach(
                  stages,
                  (found) =>
                    guarded({ stack, stage: found }, deleteStage(stack, found)),
                  { discard: true },
                ),
              ),
              Effect.andThen(
                run((client) =>
                  client.query(
                    "delete from alchemy_resource_state where stack = $1",
                    [stack],
                  ),
                ),
              ),
              Effect.andThen(
                run((client) =>
                  client.query(
                    "delete from alchemy_stack_output where stack = $1",
                    [stack],
                  ),
                ),
              ),
              Effect.asVoid,
            )
          : guarded({ stack, stage }, deleteStage(stack, stage)),
      list: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              "select fqn from alchemy_resource_state where stack = $1 and stage = $2 order by fqn",
              [request.stack, request.stage],
            ),
          ).pipe(
            Effect.map((result) => result.rows.map((row) => String(row.fqn))),
          ),
        ),
      getOutput: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              "select value from alchemy_stack_output where stack = $1 and stage = $2",
              [request.stack, request.stage],
            ),
          ).pipe(
            Effect.map((result) => {
              const row = result.rows[0];
              return row === undefined
                ? undefined
                : reviveStateRecursive(row.value);
            }),
          ),
        ),
      setOutput: (request) =>
        guarded(
          request,
          run((client) =>
            client.query(
              `
                insert into alchemy_stack_output (stack, stage, value, updated_at)
                values ($1, $2, $3::jsonb, now())
                on conflict (stack, stage) do update
                  set value = excluded.value, updated_at = excluded.updated_at
              `,
              [request.stack, request.stage, jsonParam(request.value)],
            ),
          ).pipe(Effect.map(() => request.value)),
        ),
    };
    return service;
  });
