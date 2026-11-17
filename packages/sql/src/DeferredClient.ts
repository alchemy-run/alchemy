import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, isSqlError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";

type TransformRows = (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined;

/**
 * What a driver supplies to {@link makeDeferredClient}.
 */
export interface DeferredClientOptions<Client extends SqlClient.SqlClient, E, R> {
  /** The driver name, exposed as `SqlClient.driver`. */
  readonly driver: string;
  /** The driver's statement compiler. Building one is pure, so it exists at Construction phase. */
  readonly compiler: Statement.Compiler;
  /** The driver's result transform (`transformResultNames`), if configured. */
  readonly transformRows?: TransformRows;
  /** Attributes for each statement's span. Only what is known before connecting. */
  readonly spanAttributes: ReadonlyArray<readonly [string, unknown]>;
  /**
   * Opens the driver's real client. Runs at most once per execution, with
   * that execution's `Scope`, so the pool closes when the execution settles.
   */
  readonly connect: Effect.Effect<Client, E, R | Scope.Scope>;
}

/**
 * A `SqlClient` that exists before its database does.
 */
export interface DeferredClient<Client extends SqlClient.SqlClient> {
  /**
   * A real `SqlClient`: statements, fragments and helpers are built and
   * compiled by the driver's own compiler. Only running one reaches the
   * database.
   */
  readonly client: SqlClient.SqlClient;
  /**
   * This execution's real client, opened on first use. A driver forwards its
   * own extras (`PgClient.listen`, `D1Client.batch`) through it.
   */
  readonly connected: Effect.Effect<Client, SqlError>;
}

/**
 * Build a `SqlClient` at Construction phase for a database that can only be
 * reached while handling an event.
 *
 * A Runtime resolves its clients once, at Construction phase, and uses them
 * in every handler. No connection can exist yet: the connection string comes
 * from the Runtime's environment, and a socket belongs to the event that
 * opened it. So the client is split at the one place it does I/O. Everything
 * that builds a query (`` sql`...` ``, `sql.insert`, `sql.and`, an ORM on
 * top) is the driver's real, synchronous code. The `Connection` underneath
 * forwards each compiled statement to the real client, which `connect` opens
 * once per execution.
 *
 * ```typescript
 * const { client, connected } = yield* makeDeferredClient({
 *   driver: "pg",
 *   compiler: PgClient.makeCompiler(),
 *   spanAttributes: [["db.system.name", "postgresql"]],
 *   connect: Effect.flatMap(url, (url) => PgClient.make({ url })),
 * });
 * ```
 *
 * A statement inside `client.withTransaction` runs on the real client's
 * transaction connection, and a nested `withTransaction` is a savepoint on
 * it. A failure of `connect` that isn't a `SqlError` becomes one with a
 * `ConnectionError` reason, because a statement can fail with nothing else.
 *
 * `connect` needs an execution `Scope`, so running a statement outside one
 * is a defect. A `stream` opens its own scope, and so its own client, which
 * closes when the stream ends.
 */
export const makeDeferredClient = Effect.fn(function* <Client extends SqlClient.SqlClient, E, R>(
  options: DeferredClientOptions<Client, E, R>,
) {
  const memo = yield* makeExecutionMemo(options.connect);
  // A statement has no requirements, and every Runtime provides the
  // services a connection source reads (`RuntimeContext`) to the fibers that
  // run handlers. This is the one place the requirement is dropped.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Runtime that runs the handler provides what the connection source reads
  const connected = Effect.mapError(memo, (error) =>
    isSqlError(error)
      ? error
      : SqlError.make({
          reason: ConnectionError.make({
            message: "Failed to open the database connection",
            operation: "connect",
            cause: error,
          }),
        }),
  ) as Effect.Effect<Client, SqlError>;

  // The deferred statement already ran the statement transformer and owns
  // the span, so the real client's statement skips both.
  const forward = <A>(run: (real: Client) => Effect.Effect<A, SqlError>) =>
    Effect.flatMap(connected, (real) =>
      run(real).pipe(
        Effect.provideService(Statement.CurrentTransformer, undefined),
        Effect.provideService(References.TracerEnabled, false),
      ),
    );

  const transformed = <A extends object>(
    rows: Effect.Effect<ReadonlyArray<A>, SqlError>,
    transformRows: TransformRows,
  ) => (transformRows === undefined ? rows : Effect.map(rows, transformRows));

  // The statement is already compiled, so it goes to the real client as a
  // literal with its parameters. `withoutTransforms` keeps the real client
  // from transforming rows a second time.
  const connection: Connection = {
    execute: (sql, params, transformRows) =>
      transformed(
        forward((real) => real.unsafe<object>(sql, params).withoutTransform),
        transformRows,
      ),
    executeRaw: (sql, params) => forward((real) => real.unsafe(sql, params).raw),
    executeValues: (sql, params) => forward((real) => real.unsafe(sql, params).values),
    executeValuesUnprepared: (sql, params) =>
      forward((real) => real.unsafe(sql, params).valuesUnprepared),
    executeUnprepared: (sql, params, transformRows) =>
      transformed(
        forward((real) => real.withoutTransforms().unsafe<object>(sql, params).unprepared),
        transformRows,
      ),
    executeStream: (sql, params, transformRows) => {
      const rows = Stream.unwrap(
        Effect.map(connected, (real) =>
          real
            .withoutTransforms()
            .unsafe<object>(sql, params)
            .stream.pipe(
              Stream.provideService(Statement.CurrentTransformer, undefined),
              Stream.provideService(References.TracerEnabled, false),
            ),
        ),
      );
      return transformRows === undefined
        ? rows
        : Stream.mapArray(rows, (chunk) => transformRows(chunk) as typeof chunk);
    },
  };

  const base = yield* SqlClient.make({
    driver: options.driver,
    compiler: options.compiler,
    spanAttributes: options.spanAttributes,
    transformRows: options.transformRows,
    acquirer: Effect.succeed(connection),
    // Without a borrower each statement runs in its own scope, and the
    // execution memo would open and close a client per statement.
    borrower: (use) => use(connection),
    transactionAcquirer: Effect.flatMap(connected, (real) => real.reserve),
  }).pipe(Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make));

  // The real client that opened each transaction level. A nested scope
  // changes which client `connected` returns, and a transaction must stay on
  // the client that began it.
  const owners = new WeakMap<object, Client>();
  const ownerOf = (context: Context.Context<never>) => {
    const level = Context.getOrUndefined(context, base.transactionService);
    return level === undefined ? undefined : owners.get(level);
  };

  const withTransaction = <A, Err, Req>(effect: Effect.Effect<A, Err, Req>) =>
    Effect.withFiber<A, Err | SqlError, Req>((fiber) => {
      const owner = ownerOf(fiber.context);
      return Effect.flatMap(owner === undefined ? connected : Effect.succeed(owner), (real) =>
        real.withTransaction(
          Effect.withFiber<A, Err, Req>((inner) => {
            // The real client's transaction level, provided under this
            // client's service: statements pick up the transaction's
            // connection, and `afterCommit` finds the level's callbacks.
            const level = Context.getOrUndefined(inner.context, real.transactionService);
            if (level === undefined) return effect;
            owners.set(level, real);
            return Effect.provideService(effect, base.transactionService, level);
          }),
        ),
      );
    });

  // An execution's own instance, like the real client's: a subscription
  // must not outlive the event that made it.
  const reactivity = yield* makeExecutionMemo(Reactivity.make);

  // Outside a transaction this runs the callback at once.
  const afterCommitNow = base.afterCommit;

  const client: SqlClient.SqlClient = Object.assign(base, {
    withTransaction,
    afterCommit: <Req>(effect: Effect.Effect<void, never, Req>) =>
      Effect.withFiber<void, never, Req>((fiber) => {
        const owner = ownerOf(fiber.context);
        return owner === undefined
          ? afterCommitNow(effect)
          : owner.afterCommit(
              // The callback runs after the transaction: drop this client's
              // level too, so its statements use a new connection.
              Effect.updateContext(
                effect,
                (context: Context.Context<never>) =>
                  Context.omit(base.transactionService)(context) as Context.Context<Req>,
              ),
            );
      }),
    reactive: <A, Err, Req>(
      keys: Parameters<SqlClient.SqlClient["reactive"]>[0],
      effect: Effect.Effect<A, Err, Req>,
    ) => Stream.unwrap(Effect.map(reactivity, (instance) => instance.stream(keys, effect))),
    reactiveMailbox: <A, Err, Req>(
      keys: Parameters<SqlClient.SqlClient["reactiveMailbox"]>[0],
      effect: Effect.Effect<A, Err, Req>,
    ) => Effect.flatMap(reactivity, (instance) => instance.query(keys, effect)),
  });

  return { client, connected } satisfies DeferredClient<Client>;
});
