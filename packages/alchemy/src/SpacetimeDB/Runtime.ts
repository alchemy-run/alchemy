import * as Context from "effect/Context";
import * as Data from "effect/Data";
import { ServiceTypeId } from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ConnectClient } from "./Connect.ts";

/**
 * Minimal duck-type for a generated SpacetimeDB `DbConnection`.
 * The real type is module-specific (`module_bindings`); we only require
 * `disconnect()` for lifecycle cleanup.
 */
export interface Disconnectable {
  readonly disconnect: () => void;
}

/**
 * Builder shape produced by generated `DbConnection.builder()`.
 */
export interface DbConnectionBuilderLike<C extends Disconnectable> {
  withUri(uri: string): this;
  withDatabaseName(name: string): this;
  withToken?(token?: string): this;
  onConnect(cb: (conn: C, identity: unknown, token: string) => void): this;
  onConnectError(cb: (ctx: unknown, error: Error) => void): this;
  onDisconnect?(cb: (ctx: unknown, error: Error | null) => void): this;
  build(): C;
}

export interface DbConnectionFactory<C extends Disconnectable> {
  builder(): DbConnectionBuilderLike<C>;
}

export class SpacetimeDBConnectionError extends Data.TaggedError(
  "SpacetimeDBConnectionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ConnectionConfig {
  readonly uri: string;
  readonly databaseName: string;
  readonly token?: string;
  /**
   * Unique name for this connection. Used as the Effect Context key suffix
   * so two connections in one app don't collide.
   */
  readonly name: string;
  /**
   * How long to wait for `onConnect` before failing.
   * @default "15 seconds"
   */
  readonly connectTimeout?: Duration.Input;
}

/**
 * Build a scoped Layer that opens a SpacetimeDB `DbConnection` on acquire
 * and disconnects on release. Pass the generated `DbConnection` class from
 * your module bindings:
 *
 * ```typescript
 * import { DbConnection } from "./module_bindings";
 *
 * const SpacetimeLive = makeConnectionLayer(DbConnection, {
 *   name: "todos",
 *   uri: "wss://maincloud.spacetimedb.com",
 *   databaseName: "my-game",
 * });
 * ```
 *
 * Inside the Worker / process Effect, look up the connection by its name
 * (the Effect Context key suffix prevents collisions between connections):
 *
 * ```typescript
 * const conn = yield* Connection<typeof DbConnection>("todos");
 * conn.reducers.addTodo({ text: "ship it" });
 * ```
 *
 * Prefer {@link makeConnectionLayerFromConnect} when the host already has
 * a {@link Connect} binding so uri/name come from deploy-time outputs.
 */
export const makeConnectionLayer = <C extends Disconnectable>(
  factory: DbConnectionFactory<C>,
  config: ConnectionConfig,
): Layer.Layer<Connection<C>, SpacetimeDBConnectionError> =>
  Layer.effect(Connection<C>(config.name), openConnection(factory, config));

/**
 * Like {@link makeConnectionLayer}, but resolves uri/databaseName from a
 * {@link ConnectClient} at Layer build / request time.
 *
 * ```typescript
 * const spacetime = yield* SpacetimeDB.Connect(GameDb);
 * // ...
 * }).pipe(
 *   Effect.provide(SpacetimeDB.ConnectBinding),
 *   Effect.provide(makeConnectionLayerFromConnect(DbConnection, spacetime)),
 * )
 * ```
 */
export const makeConnectionLayerFromConnect = <C extends Disconnectable>(
  factory: DbConnectionFactory<C>,
  connect: ConnectClient,
  options: {
    readonly name: string;
    readonly token?: string;
    readonly connectTimeout?: Duration.Input;
  },
): Layer.Layer<Connection<C>, SpacetimeDBConnectionError, RuntimeContext> =>
  Layer.effect(
    Connection<C>(options.name),
    Effect.gen(function* () {
      const uri = yield* connect.uri;
      const databaseName = yield* connect.databaseName;
      return yield* openConnection(factory, {
        name: options.name,
        uri,
        databaseName,
        token: options.token,
        connectTimeout: options.connectTimeout,
      });
    }),
  );

/**
 * Context tag for an open SpacetimeDB connection. Parameterized by the
 * generated connection type. The `name` must be unique per connection
 * within the runtime Context (e.g. the database name) so two databases
 * in one app don't collide.
 */
export interface Connection<C extends Disconnectable = Disconnectable> {
  readonly [ServiceTypeId]: typeof ServiceTypeId;
}

export const Connection = <C extends Disconnectable = Disconnectable>(
  name: string,
) => Context.Service<Connection<C>, C>(`SpacetimeDB::Connection/${name}`);

const openConnection = <C extends Disconnectable>(
  factory: DbConnectionFactory<C>,
  config: ConnectionConfig,
): Effect.Effect<C, SpacetimeDBConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const connected = yield* Deferred.make<C, SpacetimeDBConnectionError>();
      let builder = factory
        .builder()
        .withUri(config.uri)
        .withDatabaseName(config.databaseName)
        .onConnect((conn) => {
          Deferred.doneUnsafe(connected, Effect.succeed(conn));
        })
        .onConnectError((_ctx, error) => {
          Deferred.doneUnsafe(
            connected,
            Effect.fail(
              new SpacetimeDBConnectionError({
                message: `SpacetimeDB connection failed: ${error.message}`,
                cause: error,
              }),
            ),
          );
        });

      if (config.token !== undefined && builder.withToken) {
        builder = builder.withToken(config.token);
      }

      // build() kicks off the async handshake; we wait for onConnect.
      const conn = yield* Effect.sync(() => builder.build());

      const timeout = config.connectTimeout ?? "15 seconds";
      return yield* Deferred.await(connected).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new SpacetimeDBConnectionError({
                  message: `SpacetimeDB connection timed out after ${String(timeout)}`,
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            try {
              conn.disconnect();
            } catch {
              /* ignore */
            }
          }),
        ),
      );
    }),
    (conn) =>
      Effect.sync(() => {
        try {
          conn.disconnect();
        } catch {
          /* ignore */
        }
      }),
  );
