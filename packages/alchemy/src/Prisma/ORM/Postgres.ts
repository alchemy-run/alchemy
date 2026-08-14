// `@prisma/orm-postgres` (and pg underneath) are optional peers — value
// imports are deferred to first use so `alchemy/Prisma` resolves without
// them installed. This module is deliberately NOT exported from the barrel;
// import it as `alchemy/Prisma/ORM/Postgres`.
import type { SqlStorage } from "@prisma/orm-family-sql/contract/types";
import type { Contract } from "@prisma/orm-postgres/contract/types";
import type {
  RuntimeConnection,
  RuntimeTransaction,
} from "@prisma/orm-family-sql/runtime";
import type {
  SqlExecutionPlan,
  SqlQueryPlan,
} from "@prisma/orm-postgres/relational-core/plan";
import type {
  PostgresClient,
  PostgresOptionsBase,
} from "@prisma/orm-postgres/runtime";
import type { PostgresStaticContext } from "@prisma/orm-postgres/static";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { makeExecutionMemo } from "../../Runtime/ExecutionMemo.ts";
import { type ClientError, RollbackError, wrapPrismaError } from "./Errors.ts";
import { type EffectOrm, makeOrmProxy } from "./OrmClient.ts";

export * from "./Errors.ts";
export type { EffectCollection, EffectOrm, WhereFilter } from "./OrmClient.ts";

/** Any emitted prisma-next contract (the `Contract` type from `contract.d.ts`). */
export type AnyPostgresContract = Contract<SqlStorage>;

/** A plan produced by the `sql` builder lane (`db.sql...build()`) or `raw`. */
export type Plan<Row> = SqlQueryPlan<Row> | SqlExecutionPlan<Row>;

export interface PostgresConfig extends PostgresOptionsBase {
  /**
   * The emitted contract IR — import it from the `contract.json` written by
   * {@link Contract} (or `prisma-next contract emit`):
   *
   * ```typescript
   * import contractJson from "./prisma/contract.json" with { type: "json" };
   * ```
   */
  readonly contractJson: unknown;
}

/**
 * The transaction scope handed to {@link PostgresDatabase.transaction}'s
 * callback: the same `orm`/`execute` surfaces bound to the open
 * transaction, plus a typed `rollback`.
 */
export interface PostgresTransaction<C extends AnyPostgresContract> {
  /** The orm lane, executing on this transaction's connection. */
  readonly orm: EffectOrm<C>;
  /** Run a `sql`-lane or `raw` plan on this transaction's connection. */
  execute<Row>(plan: Plan<Row>): Effect.Effect<Row[], ClientError>;
  /**
   * Abort the transaction: rolls back and fails the `transaction` effect
   * with {@link RollbackError} (catchable by tag).
   */
  rollback(): Effect.Effect<never, RollbackError>;
}

export interface PostgresDatabase<
  C extends AnyPostgresContract,
  E = never,
  R = never,
> {
  /**
   * The prisma-next client for the current execution. An escape hatch for
   * surfaces the Effect facade does not cover yet (`groupBy`, `combine`,
   * `variant`, `prepare`); prefer {@link orm} / {@link execute}.
   */
  readonly client: Effect.Effect<PostgresClient<C>, E, R>;
  /**
   * Run promise-land code against the execution's client:
   *
   * ```typescript
   * const rows = yield* db.use((c) => c.orm.public.User.groupBy(...)...);
   * ```
   */
  readonly use: <A>(
    f: (client: PostgresClient<C>) => PromiseLike<A>,
  ) => Effect.Effect<A, ClientError | E, R>;
  /**
   * The Effect-native orm lane — chain like prisma-next, yield the
   * terminal:
   *
   * ```typescript
   * const user = yield* db.orm.public.User.where({ email }).include("posts").first();
   * ```
   */
  readonly orm: EffectOrm<C, ClientError | E, R>;
  /**
   * The pure `sql` builder lane (no connection — plans are data):
   * `db.sql.public.user.select("id", "email").build()`.
   */
  readonly sql: PostgresStaticContext<C>["sql"];
  /** The raw SQL tagged-template lane (pure — produces expressions/plans). */
  readonly raw: PostgresStaticContext<C>["raw"];
  /** Execute a plan, buffering all rows. */
  execute<Row>(plan: Plan<Row>): Effect.Effect<Row[], ClientError | E, R>;
  /** Execute a plan as a row stream (each run re-executes the plan). */
  stream<Row>(plan: Plan<Row>): Stream.Stream<Row, ClientError | E, R>;
  /**
   * Run `f` inside a database transaction on a dedicated connection.
   * Commits on success; rolls back on failure or interruption. Yield
   * `tx.rollback()` to abort with a typed {@link RollbackError}.
   */
  transaction<A, E2, R2>(
    f: (tx: PostgresTransaction<C>) => Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E2 | ClientError | E, R | R2>;
}

/**
 * Open a Prisma ORM v8 (prisma-next) Postgres client from a connection URL,
 * with Effect-native query surfaces over prisma-next's own builders and
 * engine.
 *
 * The client is built at most once per execution — a Worker
 * `fetch`/`queue`/`scheduled` event, a Durable Object call, a Workflow run,
 * or a Lambda invocation — and memoized on the execution's `Scope` (via
 * {@link makeExecutionMemo}), with `close()` registered as a scope finalizer
 * so the underlying `pg` pool never outlives its event. That per-execution
 * lifecycle is what makes the client safe on workerd, where sockets are
 * pinned to the creating request's IoContext. Construction does no I/O
 * (prisma-next connects lazily on the first query), so deploy/plan-time
 * evaluations never touch the database.
 *
 * The factory is curried (`Postgres<Contract>()(source, config)`, like
 * `Cloudflare.Worker<T>()`) so the contract type is explicit while the
 * source's error/requirement channels still infer:
 *
 * ```typescript
 * import * as PrismaPostgres from "alchemy/Prisma/ORM/Postgres";
 * import type { Contract } from "./prisma/contract.d.ts";
 * import contractJson from "./prisma/contract.json" with { type: "json" };
 *
 * const db = yield* PrismaPostgres.Postgres<Contract>()(
 *   Cloudflare.Hyperdrive.Connect(hyperdrive).connectionString,
 *   { contractJson },
 * );
 *
 * fetch: Effect.gen(function* () {
 *   // orm lane — queries ARE Effects, with typed errors
 *   const user = yield* db.orm.public.User.where({ email }).include("posts").first();
 *   const made = yield* db.orm.public.Post.create({ title, authorId: user.id });
 *
 *   // sql builder lane — pure plans, Effect executor
 *   const rows = yield* db.execute(db.sql.public.user.select("id", "email").build());
 *
 *   // transactions — commit on success, rollback on failure/interrupt
 *   yield* db.transaction((tx) =>
 *     Effect.gen(function* () {
 *       const u = yield* tx.orm.public.User.create({ email });
 *       if (!u) return yield* tx.rollback();
 *       return u;
 *     }),
 *   );
 * });
 * ```
 *
 * Queries are lazy and re-runnable: each evaluation replays the chain
 * against the execution's client, so `Effect.retry` re-issues the query.
 * Failures surface as granular tagged errors: the SQL-standard integrity
 * violations each get their own tag (`Prisma.UniqueViolationError`,
 * `Prisma.ForeignKeyViolationError`, `Prisma.NotNullViolationError`,
 * `Prisma.CheckViolationError`), other statement failures are
 * `Prisma.QueryError` (with the normalized `sqlState`), connection
 * failures are `Prisma.ConnectionError` (with the driver's
 * `transient` verdict), and prisma-next's structured codes split by
 * category into `Prisma.OrmError` / `Prisma.RuntimeError`
 * with an autocompleting `code` field.
 *
 * @binding
 * @category ORM
 */
export const Postgres =
  <C extends AnyPostgresContract>() =>
  <E = never, R = never>(
    connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
    config: PostgresConfig,
  ): Effect.Effect<PostgresDatabase<C, E, R>> =>
    Effect.gen(function* () {
      const { contractJson, ...options } = config;

      // Loaded once per instance (isolate init / first event): the runtime
      // factory, the driverless static surface, and the orm constructor
      // (used to bind tx-scoped orm lanes).
      const modules = yield* Effect.promise(() =>
        Promise.all([
          import("@prisma/orm-postgres/runtime"),
          import("@prisma/orm-postgres/static"),
          import("@prisma/orm-postgres/orm-client"),
        ]),
      );
      const [runtimeModule, staticModule, ormModule] = modules;

      // Pure static context: the typed sql/raw builders and the codec
      // machinery, with no driver and no connection behind them.
      const statics = staticModule.default<C>({ contractJson });

      const client = yield* makeExecutionMemo(
        Effect.gen(function* () {
          const url = Redacted.value(yield* connectionString);
          const instance = runtimeModule.default<C>({
            contractJson,
            url,
            ...options,
          });
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise(() => instance.close()).pipe(Effect.ignore),
          );
          return instance;
        }),
      );

      const execute = <Row>(
        plan: Plan<Row>,
      ): Effect.Effect<Row[], ClientError | E, R> =>
        Effect.flatMap(client, (c) =>
          Effect.tryPromise({
            try: (signal) => c.runtime().execute(plan, { signal }).toArray(),
            catch: wrapPrismaError,
          }),
        );

      const stream = <Row>(
        plan: Plan<Row>,
      ): Stream.Stream<Row, ClientError | E, R> =>
        // unwrap re-evaluates per run, so each run gets a fresh
        // AsyncIterableResult (they are single-consumption).
        Stream.unwrap(
          Effect.map(client, (c) =>
            Stream.fromAsyncIterable(
              c.runtime().execute(plan) as AsyncIterable<Row>,
              wrapPrismaError,
            ),
          ),
        );

      const makeTransactionScope = (txn: RuntimeTransaction) => {
        const txOrm = ormModule.orm<C>({
          runtime: { execute: (plan) => txn.execute(plan) },
          context: statics.context,
        });
        const tx: PostgresTransaction<C> = {
          orm: makeOrmProxy<C, never, never>(Effect.sync(() => txOrm)),
          execute: <Row>(plan: Plan<Row>) =>
            Effect.tryPromise({
              try: () =>
                Promise.resolve(txn.execute(plan) as PromiseLike<Row[]>),
              catch: wrapPrismaError,
            }),
          rollback: () => Effect.fail(new RollbackError()),
        };
        return tx;
      };

      const transaction = <A, E2, R2>(
        f: (tx: PostgresTransaction<C>) => Effect.Effect<A, E2, R2>,
      ): Effect.Effect<A, E2 | ClientError | E, R | R2> =>
        Effect.flatMap(client, (c) =>
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: async () => {
                const connection: RuntimeConnection = await c
                  .runtime()
                  .connection();
                try {
                  const txn = await connection.transaction();
                  return { connection, txn, committed: false };
                } catch (error) {
                  await connection.destroy(error).catch(() => {});
                  throw error;
                }
              },
              catch: wrapPrismaError,
            }),
            (scope) =>
              f(makeTransactionScope(scope.txn)).pipe(
                Effect.flatMap((value) =>
                  Effect.tryPromise({
                    try: async () => {
                      await scope.txn.commit();
                      scope.committed = true;
                      return value;
                    },
                    catch: wrapPrismaError,
                  }),
                ),
              ),
            (scope) =>
              // Rollback on any non-committed exit (failure, interrupt, or
              // commit failure), then return the connection to the pool —
              // destroying it if cleanup itself failed.
              Effect.promise(async () => {
                try {
                  if (!scope.committed) await scope.txn.rollback();
                  await scope.connection.release();
                } catch (error) {
                  await scope.connection.destroy(error).catch(() => {});
                }
              }),
          ),
        );

      const db: PostgresDatabase<C, E, R> = {
        client,
        use: (f) =>
          Effect.flatMap(client, (c) =>
            Effect.tryPromise({
              try: () => Promise.resolve(f(c)),
              catch: wrapPrismaError,
            }),
          ),
        orm: makeOrmProxy<C, ClientError | E, R>(
          Effect.map(client, (c) => c.orm),
        ),
        sql: statics.sql,
        raw: statics.raw,
        execute,
        stream,
        transaction,
      };
      return db;
    });
