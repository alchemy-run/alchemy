/**
 * Objects on Effect Cluster: `alchemy/Workers/ObjectHost` on one entity,
 * which Domain's models and AI's sessions are built on.
 *
 * @module
 */
import type { HttpEffect } from "alchemy/Http";
import { decodeRpcArgs, encodeRpcArgs } from "alchemy/Rpc";
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { type InputGateShape, makeInputGate } from "alchemy/Workers/InputGate";
import {
  ATTACHMENT_HEADER,
  type ListOptions,
  type Namespace,
  type ObjectImpl,
  ObjectHost,
  type ObjectSocket,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  objectName,
  parseObjectName,
} from "alchemy/Workers/ObjectHost";
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import { ClusterSchema, DeliverAt, Entity as EffectEntity, Sharding } from "effect/cluster";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ServerRequest from "effect/http/HttpServerRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PrimaryKey from "effect/PrimaryKey";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { SqlClient } from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { WorkflowEngine } from "effect/workflow";
import { databaseMaxConnections } from "./Database.ts";
import {
  Entity,
  type EntityNamespace,
  type EntityRuntimeContext,
  PlatformDeclaration,
} from "./Entity.ts";
import {
  HasNoPool,
  InstanceSockets,
  InstanceStorage,
  makeNamespace,
  RunnerHost,
  SOCKET_HEADER,
} from "./Host.ts";
import type { PoolLayer } from "./Pool.ts";
import type { Providers } from "./Providers.ts";

/** Where every instance keeps its storage: one row per key, in the cluster's database. */
export const TABLE = "alchemy_domain_objects";

const encode = (value: unknown) => JSON.stringify(value ?? null);
const decode = <T>(text: string) => JSON.parse(text) as T;

/**
 * An object's storage for one entity id over the cluster's Postgres. Every
 * operation goes through the instance's input gate, as on Cloudflare. Each
 * row keeps when it was last written (`at`), for retention.
 */
export const objectStorage = (
  sql: SqlClient,
  object: string,
  gate: InputGateShape,
): ObjectStorage => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => gate.storage(Effect.orDie(effect));
  const putOne = (key: string, value: unknown, at: number) =>
    sql`INSERT INTO ${sql(TABLE)} (object, key, value, at) VALUES (${object}, ${key}, ${encode(value)}, ${at})
        ON CONFLICT (object, key) DO UPDATE SET value = excluded.value, at = excluded.at`;
  return {
    get: <T>(key: string) =>
      run(
        sql<{
          value: string;
        }>`SELECT value FROM ${sql(TABLE)} WHERE object = ${object} AND key = ${key}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? undefined : decode<T>(rows[0].value))),
        ),
      ),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      run(
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          typeof keyOrEntries === "string"
            ? Effect.asVoid(putOne(keyOrEntries, value, at))
            : Effect.forEach(
                Object.entries(keyOrEntries),
                ([key, entry]) => putOne(key, entry, at),
                { discard: true },
              ),
        ),
      )) as ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) => {
      const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
      const deleted =
        keys.length === 0
          ? Effect.succeed(0)
          : sql<{
              key: string;
            }>`DELETE FROM ${sql(TABLE)} WHERE object = ${object} AND ${sql.in("key", keys)} RETURNING key`.pipe(
              Effect.map((rows) => rows.length),
            );
      return run<number | boolean>(
        typeof keyOrKeys === "string" ? Effect.map(deleted, (n) => n > 0) : deleted,
      );
    }) as ObjectStorage["delete"],
    list: <T>({ prefix, start, startAfter, end, limit, reverse }: ListOptions = {}) =>
      run(
        sql<{ key: string; value: string }>`SELECT key, value FROM ${sql(TABLE)}
          WHERE object = ${object}
          ${prefix ? sql`AND starts_with(key, ${prefix})` : sql``}
          ${start !== undefined ? sql`AND key >= ${start}` : sql``}
          ${startAfter !== undefined ? sql`AND key > ${startAfter}` : sql``}
          ${end !== undefined ? sql`AND key < ${end}` : sql``}
          ${reverse ? sql`ORDER BY key DESC` : sql`ORDER BY key`}
          ${limit !== undefined ? sql`LIMIT ${Math.max(0, limit | 0)}` : sql``}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.key, decode<T>(row.value)]))),
        ),
      ),
    // Held across the whole transaction, as Cloudflare's gate is. The gate
    // is this process's: a runner that stalled past its shard lock and
    // resumed still runs the instance while another runner runs it too. So
    // the transaction first takes the instance's lock in Postgres, and one
    // instance's transactions run one at a time across runners. What a
    // transaction then reads is what the last one committed, so a write
    // decided from an earlier version sees that and writes nothing .
    transaction: (effect) =>
      gate.exclusive(
        sql
          .withTransaction(
            Effect.andThen(
              run(sql`SELECT pg_advisory_xact_lock(hashtextextended(${object}, 0))`),
              effect,
            ),
          )
          .pipe(Effect.orDie),
      ) as never,
  };
};

/**
 * Create the storage table, or add what a newer host needs to it. Runners
 * start together, so one at a time: the others wait on the lock.
 *
 * A table that has everything gets no DDL: `ALTER TABLE` and `CREATE INDEX`
 * lock the table even when they change nothing, so every runner that starts
 * would wait for the open transactions of the others and hold their queries.
 */
export const migrate = (sql: SqlClient) =>
  Effect.gen(function* () {
    const [table] = yield* sql<{ migrated: boolean }>`SELECT (
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass(${TABLE}) AND attname = 'at' AND NOT attisdropped
        ) AND to_regclass(${`${TABLE}_at`}) IS NOT NULL
      ) AS migrated`;
    if (table?.migrated) return;
    yield* migrateLocked(sql);
  }).pipe(Effect.orDie);

const migrateLocked = (sql: SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${TABLE}))`;
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
          object TEXT COLLATE "C" NOT NULL,
          key TEXT COLLATE "C" NOT NULL,
          value TEXT NOT NULL,
          at BIGINT,
          PRIMARY KEY (object, key)
        )`;
      // A table made by an earlier host: its rows have no time yet; the
      // first sweep gives them one.
      yield* sql`ALTER TABLE ${sql(TABLE)} ADD COLUMN IF NOT EXISTS at BIGINT`;
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(`${TABLE}_at`)} ON ${sql(TABLE)} (at)`;
    }),
  );

/**
 * Wake an instance at `at`: a persisted message delivered when it is due,
 * so it survives restarts and moves with the instance.
 */
class Wake extends Schema.Class<Wake>("alchemy/Domain/Cluster/Wake")({
  at: Schema.Number,
  id: Schema.String,
}) {
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
  [PrimaryKey.symbol]() {
    return `${this.at}/${this.id}`;
  }
}

/** What a live read's socket sends, crossing from the object to the caller that holds the socket. */
export const LiveFrame = Schema.Union([
  Schema.TaggedStruct("Frame", { text: Schema.String }),
  Schema.TaggedStruct("Close", { code: Schema.Number, reason: Schema.String }),
]);
export type LiveFrame = typeof LiveFrame.Type;

/** The method a stub reaches a live read with, instead of a call. */
export const LIVE_METHOD = "~live";

/**
 * The method a stub opens a live read's WebSocket to the instance's own
 * object with, where the pool gives it one: `undefined` elsewhere.
 */
export const CONNECT_METHOD = "~connect";

/**
 * The socket the current `Connect` call carries: the instance's object
 * accepted it, and `accept` takes it.
 */
const ConnectCall = Context.Reference<string | undefined>("alchemy/Domain/Cluster/ConnectCall", {
  defaultValue: () => undefined,
});

/**
 * The live read the current `Live` call serves: `accept` hands its socket
 * to the object, which pushes into the call's frames.
 */
const LiveCall = Context.Reference<Queue.Queue<LiveFrame, Cause.Done> | undefined>(
  "alchemy/Domain/Cluster/LiveCall",
  { defaultValue: () => undefined },
);

/** A socket whose frames are the `Live` call's, kept by the instance while it is open. */
const liveSocket = (
  queue: Queue.Queue<LiveFrame, Cause.Done>,
  open: Map<ObjectSocket, Queue.Queue<LiveFrame, Cause.Done>>,
): ObjectSocket => {
  let attachment: unknown = null;
  const socket: ObjectSocket = {
    send: (text) => Effect.asVoid(Queue.offer(queue, { _tag: "Frame", text })),
    close: (code, reason) =>
      Effect.gen(function* () {
        open.delete(socket);
        yield* Queue.offer(queue, { _tag: "Close", code, reason });
        yield* Queue.end(queue);
      }),
    serializeAttachment: (value) => {
      attachment = value === undefined ? null : structuredClone(value);
    },
    deserializeAttachment: <T>() =>
      (attachment === null ? null : structuredClone(attachment)) as T | null,
  };
  open.set(socket, queue);
  return socket;
};

const rpcs = [
  Rpc.make("Call", {
    // Arguments and results cross runners as JSON text, as fetch-RPC sends them.
    payload: { method: Schema.String, args: Schema.String },
    success: Schema.String,
  }),
  Rpc.make("Wake", { payload: Wake }).annotate(ClusterSchema.Persisted, true),
  // A live read: the object pushes each frame its socket sends, and ends
  // with how the socket closed.
  Rpc.make("Live", {
    payload: { attachment: Schema.String },
    success: LiveFrame,
    stream: true,
  }),
  // A live read whose WebSocket the instance's object holds: the instance
  // takes the socket the call carries, and answers the upgrade's status.
  Rpc.make("Connect", {
    payload: { attachment: Schema.String },
    success: Schema.Number,
  }),
] as const;

type ObjectRpcs = (typeof rpcs)[number];

/** The entity that holds the objects: each is one entity id of it (`Bank.AccountAggregate/a-1`). */
const entity = <const Type extends string>(type: Type): EffectEntity.Entity<Type, ObjectRpcs> =>
  EffectEntity.make(type, rpcs);

/**
 * One storage pool per database for the life of the process, opened by
 * `open` on first use. Concurrent first uses open it once; an open that
 * fails isn't kept, so the next use tries again.
 */
const makeStoragePools = (
  open: (url: Redacted.Redacted<string>) => Effect.Effect<SqlClient>,
): ((url: Redacted.Redacted<string>) => Effect.Effect<SqlClient>) => {
  const pools = new Map<string, SqlClient>();
  const opening = Semaphore.makeUnsafe(1);
  const opened = (url: Redacted.Redacted<string>) => pools.get(Redacted.value(url));
  return (url) =>
    Effect.suspend(() => {
      const pool = opened(url);
      if (pool !== undefined) return Effect.succeed(pool);
      return opening.withPermits(1)(
        Effect.suspend(() => {
          const raced = opened(url);
          if (raced !== undefined) return Effect.succeed(raced);
          return Effect.tap(open(url), (client) =>
            Effect.sync(() => pools.set(Redacted.value(url), client)),
          );
        }),
      );
    });
};

/**
 * The runner's pool to the storage table. Every model the runner hosts
 * shares it, so a runner holds one storage pool however many models it
 * hosts, of at most the pool's `databaseConnections`
 * (`CLUSTER_DATABASE_MAX_CONNECTIONS`). It lives as long as the runner.
 */
const storagePool = makeStoragePools((url) => {
  const scope = Scope.makeUnsafe();
  return Effect.gen(function* () {
    const maxConnections = yield* databaseMaxConnections;
    // Loaded only on a runner with a database: a caller never opens one.
    const { PgClient } = yield* Effect.promise(() => import("@effect/sql-pg"));
    const context = yield* Layer.buildWithScope(
      PgClient.layer({ url, maxConnections }),
      scope,
    ).pipe(Effect.orDie);
    const client = Context.get(context, SqlClient);
    yield* migrate(client);
    return client;
  }).pipe(
    // A pool that didn't open isn't kept: close what it opened.
    Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
  );
});

/** The host entity was asked for an object of a class it doesn't hold. */
export class ObjectClassNotHosted extends Data.TaggedError("Cluster.ObjectClassNotHosted")<{
  readonly message: string;
}> {}

/** Calls to one entity id's object, as the contract's stubs. */
const remote =
  (namespace: EntityNamespace<ObjectRpcs>) =>
  (cls: string): Namespace => ({
    getByName: (key: string) =>
      new Proxy(
        {},
        {
          get: (_, method) =>
            method === LIVE_METHOD
              ? (attachment: string) =>
                  Stream.unwrap(
                    Effect.map(namespace.getByName(objectName(cls, key)), (client) =>
                      client.Live({ attachment }),
                    ),
                  )
              : method === CONNECT_METHOD
                ? (request: Request, attachment: string) =>
                    namespace.connect === undefined
                      ? Effect.succeed(undefined)
                      : namespace.connect(objectName(cls, key), request, {
                          tag: "Connect",
                          payload: { attachment },
                        })
                : (...args: ReadonlyArray<unknown>) =>
                    Effect.flatMap(namespace.getByName(objectName(cls, key)), (client) =>
                      client
                        .Call({ method: String(method), args: encodeRpcArgs(args) })
                        .pipe(Effect.map((result) => JSON.parse(result) as unknown)),
                    ),
        },
      ) as never,
  });

/** Options for {@link layerObjectHost}. */
export interface ObjectHostOptions<PoolReq> {
  /**
   * The module whose default export is the Layer built on this host,
   * usually `import.meta.url`. The pool's runners load it to run the objects.
   */
  readonly main: string;
  /** The pool whose runners run the objects, e.g. `ClusterDocker.SwarmPool("Default")`. */
  readonly pool: PoolLayer<PoolReq>;
}

/** What a runner of the pool has, once it has joined the cluster. */
export interface Joined {
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  readonly sharding: Sharding.Sharding["Service"];
}

/**
 * The Effect Cluster side of an object host, for what is built on it and
 * needs more than objects: the cluster's workflow engine, its database.
 */
export class ClusterObjects extends Context.Service<
  ClusterObjects,
  {
    /** The entity that holds the objects. */
    readonly name: string;
    /** The shard group the pool's runners register their entities in. */
    readonly shardGroup: () => string;
    /** Set on a runner of the pool, `undefined` in a caller. */
    readonly runner:
      | {
          /** The runner's engine and Sharding, once it has joined the cluster. */
          readonly joined: Effect.Effect<Joined>;
          /** Run `effect` as the runner joins, before {@link joined} completes. */
          readonly onJoin: (
            effect: Effect.Effect<
              void,
              never,
              WorkflowEngine.WorkflowEngine | Sharding.Sharding | Scope.Scope
            >,
          ) => Effect.Effect<void>;
          /**
           * The cluster's database, where a pool has one: every object's
           * rows are in {@link TABLE}. The Durable Object pool has none, and
           * each instance keeps its rows in its own storage.
           */
          readonly database: Option.Option<Effect.Effect<SqlClient>>;
        }
      | undefined;
  }
>()("alchemy/Cluster/ClusterObjects") {}

/**
 * Objects on Effect Cluster. Every class declared on it is held by one
 * entity, `name`: the object `a-1` of the class `Bank.AccountAggregate` is
 * the entity id `Bank.AccountAggregate/a-1`, on whichever runner holds its
 * shard. Its storage is rows of the cluster's Postgres, and its alarm a
 * persisted message delivered when it is due.
 *
 * Built in a caller (a container, a Lambda, a Worker), the Layer deploys
 * that entity to `pool` and reaches it through the pool's gateway. The
 * pool's runners load the Layer built on this one from `main`, and there the
 * same Layer holds the entity.
 *
 * It is the entrypoint of everything built on objects: provide it once, to
 * the Layer the module exports as its default. `DomainCluster.layerEntities()`
 * puts a Domain model on it, and `AI.layerObjects` a process's sessions.
 *
 * **Example:** A model and a process's sessions on one entity
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
 * import * as Cluster from "@alchemy.run/effect-cluster";
 * import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
 * import * as Layer from "effect/Layer";
 * import { Harness } from "./Harness.ts";
 * import { Board, IssueWorkLive } from "./Board.model.ts";
 * import { TriageLive } from "./Triage.process.ts";
 *
 * export const Database = ClusterDocker.Database("Cluster");
 * const Default = ClusterDocker.SwarmPool("Default").pipe(Layer.provide(Database));
 *
 * const BoardLive = Board.layer(IssueWorkLive).pipe(Layer.provide(DomainCluster.layerEntities()));
 *
 * const TriageSessions = AI.layerObjects(
 *   TriageLive.pipe(Layer.provide(Layer.mergeAll(Harness, BoardLive))),
 * );
 *
 * export default BoardLive.pipe(
 *   Layer.provideMerge(TriageSessions),
 *   Layer.provide(Cluster.layerObjectHost("App", { main: import.meta.url, pool: Default })),
 * );
 * ```
 *
 * @layer
 * @provides ObjectHost
 */
export const layerObjectHost = <PoolReq>(
  /** The entity that holds every object: its type in the cluster. */
  name: string,
  options: ObjectHostOptions<PoolReq>,
): Layer.Layer<ObjectHost | ClusterObjects, never, PoolReq | Providers> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the entity is declared dynamically; its requirements are the pool's and the providers'
  Layer.effectContext(
    Effect.gen(function* () {
      // In this pool's shard group, as the runner registers its entities.
      const shardGroup = () =>
        (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
          .CLUSTER_SHARD_GROUPS ?? "default";
      const objects = entity(name).annotate(ClusterSchema.ShardGroup, shardGroup);
      const classes = new Map<string, ObjectImpl>();
      // One Postgres pool per runner, opened on the first instance.
      const sql = Effect.flatMap(
        Config.Redacted("CLUSTER_DATABASE_URL").pipe(Effect.orDie),
        storagePool,
      );
      const provide = (host: ObjectHost["Service"], runner: ClusterObjects["Service"]["runner"]) =>
        Context.make(ObjectHost, { ...host, name }).pipe(
          Context.add(ClusterObjects, { name, shardGroup, runner }),
        );

      // Each instance builds the object its entity id says.
      const instance = Effect.gen(function* () {
        const address = yield* EffectEntity.CurrentAddress;
        const id = address.entityId;
        const parsed = parseObjectName(id);
        const build = parsed === undefined ? undefined : classes.get(parsed.className);
        if (build === undefined) {
          // A class this code no longer hosts, like a consumer's earlier
          // generation after a version bump. Its persisted wake-ups are
          // dropped: dying here would redeliver them forever. Only older
          // code calls it, and those calls fail.
          const notHosted = new ObjectClassNotHosted({
            message: `Cluster.Entity '${name}' holds no class for '${id}'.`,
          });
          return objects.of({
            Call: () => Effect.die(notHosted),
            Live: () =>
              Stream.make({ _tag: "Close", code: 1011, reason: notHosted.message } as const),
            Connect: () => Effect.die(notHosted),
            Wake: () => Effect.void,
          });
        }
        const gate = yield* makeInputGate;
        // The instance's own object where the pool gives it one; otherwise
        // its rows in the cluster's Postgres.
        const native = yield* Effect.serviceOption(InstanceStorage);
        // The object's WebSockets, where it holds them: they outlive the instance.
        const nativeSockets = Option.getOrUndefined(yield* Effect.serviceOption(InstanceSockets));
        // A Durable Object's storage has Cloudflare's input gate already, so it
        // doesn't go through this one: a transaction's callback runs in a
        // fiber of its own, which this gate would hold behind the transaction.
        const storage: ObjectStorage = Option.isSome(native)
          ? native.value
          : objectStorage(yield* sql, `${name}/${id}`, gate);
        const instanceScope = yield* Scope.Scope;
        const wakes = yield* objects.client;
        const callbacks = storageCallbacks(storage, {
          set: (at) =>
            Effect.gen(function* () {
              yield* storage.put("~alarm", at);
              const wake = wakes(id)
                .Wake(Wake.make({ at, id: String(yield* Random.nextInt) }), { discard: true })
                .pipe(Effect.orDie);
              // A Durable Object can't receive its own message while the
              // transaction that set the alarm holds its input gate, so the
              // wake goes out once the transaction lets go.
              if (Option.isSome(native)) yield* Effect.forkIn(wake, instanceScope);
              else yield* wake;
            }),
          get: storage.get<number>("~alarm").pipe(Effect.map((at) => at ?? null)),
        });
        // The live reads this instance pushes to, each the stream of a `Live` call.
        const open = new Map<ObjectSocket, Queue.Queue<LiveFrame, Cause.Done>>();
        const state: ObjectStateShape = {
          storage,
          exclusive: (effect) => gate.exclusive(effect),
          // Background work stays part of the call that started it.
          waitUntil: (effect) => Effect.asVoid(Effect.forkIn(effect, instanceScope)),
          sockets: {
            accept: () =>
              Effect.gen(function* () {
                const connecting = yield* ConnectCall;
                if (connecting !== undefined && nativeSockets !== undefined) {
                  const socket = yield* nativeSockets.accept(connecting);
                  if (socket !== undefined) {
                    return [HttpServerResponse.empty({ status: 101 }), socket] as const;
                  }
                }
                const queue = yield* LiveCall;
                if (queue === undefined) {
                  return yield* Effect.die(
                    new Error(`${id} was asked to accept outside a live read`),
                  );
                }
                return [
                  HttpServerResponse.empty({ status: 101 }),
                  liveSocket(queue, open),
                ] as const;
              }),
            all: () =>
              Effect.map(nativeSockets?.all ?? Effect.succeed([]), (held) => [
                ...held,
                ...open.keys(),
              ]),
          },
        };
        const record = yield* build.pipe(
          Effect.provideService(ObjectState, state),
          Effect.provide(callbacks.callbacks),
        );
        return objects.of({
          Call: ({ payload }) =>
            gate.call(
              Effect.suspend(() => {
                const method = record[payload.method];
                return typeof method === "function"
                  ? decodeRpcArgs(payload.args).pipe(
                      Effect.orDie,
                      Effect.flatMap((args) =>
                        (method as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                          ...args,
                        ),
                      ),
                    )
                  : Effect.die(new Error(`${id} has no method ${payload.method}`));
              }).pipe(Effect.map((result) => JSON.stringify(result ?? null))),
            ),
          // The object accepts the read as it would a WebSocket, then pushes
          // every commit into the stream until the read ends or the caller goes.
          Live: ({ payload }) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const queue = yield* Queue.unbounded<LiveFrame, Cause.Done>();
                const fetch = record.fetch as HttpEffect | undefined;
                if (fetch === undefined) {
                  return Stream.make({
                    _tag: "Close",
                    code: 1011,
                    reason: "No live reads",
                  } as const);
                }
                const request = ServerRequest.fromWeb(
                  new Request("http://object/", {
                    headers: { upgrade: "websocket", [ATTACHMENT_HEADER]: payload.attachment },
                  }),
                );
                const response = yield* gate.call(
                  fetch.pipe(
                    Effect.provideService(HttpServerRequest, request),
                    Effect.provideService(LiveCall, queue),
                    Effect.scoped,
                    Effect.orDie,
                  ),
                );
                if (response.status !== 101) {
                  return Stream.make({
                    _tag: "Close",
                    code: 1011,
                    reason: `HTTP ${response.status}`,
                  } as const);
                }
                return Stream.fromQueue(queue).pipe(
                  // The caller went away: stop pushing to it.
                  Stream.ensuring(
                    Effect.sync(() => {
                      for (const [socket, of] of open) if (of === queue) open.delete(socket);
                    }),
                  ),
                );
              }),
            ),
          // The object accepted the read's WebSocket; the instance takes it
          // as it would its own, and pushes every commit to it.
          Connect: ({ payload, headers }) =>
            Effect.gen(function* () {
              const fetch = record.fetch as HttpEffect | undefined;
              if (fetch === undefined) return 501;
              const request = ServerRequest.fromWeb(
                new Request("http://object/", {
                  headers: { upgrade: "websocket", [ATTACHMENT_HEADER]: payload.attachment },
                }),
              );
              const response = yield* gate.call(
                fetch.pipe(
                  Effect.provideService(HttpServerRequest, request),
                  Effect.provideService(ConnectCall, headers[SOCKET_HEADER]),
                  Effect.scoped,
                  Effect.orDie,
                ),
              );
              return response.status;
            }),
          Wake: ({ payload }) =>
            gate.call(
              Effect.gen(function* () {
                const at = yield* storage.get<number>("~alarm");
                if (at !== undefined && at <= payload.at) yield* storage.delete("~alarm");
                yield* callbacks.fire;
              }),
            ),
        });
      });

      const Objects = (Entity as any)()(
        objects,
        {
          main: options.main,
          handler: "default",
          // The objects call each other, and a call can come back to
          // the instance that made it; each instance's input gate keeps its
          // storage consistent.
          concurrency: "unbounded",
        },
        Effect.succeed(instance).pipe(Effect.provide(options.pool)),
      );

      const runner = yield* Effect.serviceOption(RunnerHost);
      if (Option.isSome(runner)) {
        const database = yield* Config.option(Config.Redacted("CLUSTER_DATABASE_URL")).pipe(
          Effect.orDie,
        );
        // A runner of the pool: hold the entity, as the bootstrap holds an
        // exported one, with the classes declared here.
        const context = yield* Layer.build(entrypointLayer(Objects[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as EntityRuntimeContext
        ).hosted();
        if (hosted === undefined) {
          return yield* Effect.die(
            new HasNoPool({ message: `${name} did not finish its Construction phase.` }),
          );
        }
        const joined = yield* Deferred.make<Joined>();
        const joining: Array<
          Effect.Effect<
            void,
            never,
            WorkflowEngine.WorkflowEngine | Sharding.Sharding | Scope.Scope
          >
        > = [];
        // What is built on the host registers while its Layer builds, before
        // the runner joins the cluster: hold it until then.
        yield* runner.value.host(
          hosted,
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const sharding = yield* Sharding.Sharding;
            for (const effect of joining) yield* effect;
            yield* Deferred.succeed(joined, { engine, sharding });
          }).pipe(Layer.effectDiscard),
        );
        // Inside the cluster, calls route through Effect Cluster itself.
        const self = remote(
          makeNamespace(objects as never, { url: "", token: "", service: "" }) as never,
        );
        return provide(
          {
            declare: (cls, impl) =>
              Effect.sync(() => {
                classes.set(cls, impl);
                return self(cls);
              }),
            lookup: self,
          },
          {
            joined: Deferred.await(joined),
            onJoin: (effect) => Effect.sync(() => void joining.push(effect)),
            database: Option.map(database, () => sql),
          },
        );
      }

      // A caller: deploy the entity, and reach it through the gateway.
      const self = remote((yield* Objects) as EntityNamespace<ObjectRpcs>);
      return provide({ declare: (cls) => Effect.succeed(self(cls)), lookup: self }, undefined);
    }),
  ) as Layer.Layer<ObjectHost | ClusterObjects, never, PoolReq | Providers>;
