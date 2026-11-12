import {
  Entity,
  type EntityNamespace,
  type EntityRuntimeContext,
  PlatformDeclaration,
} from "@alchemy.run/effect-cluster/Entity";
import {
  HasNoPool,
  InstanceStorage,
  makeNamespace,
  RunnerHost,
} from "@alchemy.run/effect-cluster/Host";
import type { PoolLayer } from "@alchemy.run/effect-cluster/Pool";
import type { Providers } from "@alchemy.run/effect-cluster/Providers";
/**
 * Host a domain model (`@alchemy.run/domain`) on Effect Cluster entities.
 *
 * @module
 */
import { PgClient } from "@effect/sql-pg";
import type { HttpEffect } from "alchemy/Http";
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeInputGate, type InputGateShape } from "alchemy/Workers/InputGate";
import { decodeResult, encodeResult, payloadCodec } from "alchemy/WorkflowEncoding";
import type * as Cause from "effect/Cause";
import { ClusterSchema, DeliverAt, Entity as EffectEntity } from "effect/cluster";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as Ref from "effect/Ref";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { SqlClient } from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import {
  alarmCallbacks,
  type Attachment,
  className,
  type Host,
  type ListOptions,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  type ObjectSocket,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  parseMultiplexedName,
  SUBSCRIPTION_HEADER,
} from "../DurableObjects.ts";
import type { Platform, Subscription } from "../Platform.ts";

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
const LiveFrame = Schema.Union([
  Schema.TaggedStruct("Frame", { text: Schema.String }),
  Schema.TaggedStruct("Close", { code: Schema.Number, reason: Schema.String }),
]);
type LiveFrame = typeof LiveFrame.Type;

/** The method a stub reaches a live read with, instead of a call. */
const LIVE_METHOD = "~live";

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

/**
 * Serve a live read's WebSocket (the current request) here, in the caller,
 * pushed from the object that owns `key`: the object accepts the read over
 * a `Live` call, and each frame it sends is written to the socket.
 */
const connectTo = (namespace: Namespace, key: string, subscription: Subscription): HttpEffect =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const stub = namespace.getByName(key) as unknown as {
      readonly [LIVE_METHOD]: (attachment: string) => Stream.Stream<LiveFrame, unknown>;
    };
    const frames = stub[LIVE_METHOD](JSON.stringify({ key, subscription } satisfies Attachment));
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    // The client closed: stop the read.
    const closed = Effect.scoped(
      Effect.flatMap(socket.reader, ({ pull }) => Effect.forever(pull)),
    ).pipe(Effect.ignore);
    yield* Effect.raceFirst(
      frames.pipe(
        Stream.runForEach((frame) =>
          writer.write(
            frame._tag === "Frame" ? frame.text : new Socket.CloseEvent(frame.code, frame.reason),
          ),
        ),
        Effect.catchCause(() =>
          writer.write(new Socket.CloseEvent(1011, "The live read failed")).pipe(Effect.ignore),
        ),
      ),
      closed,
    );
    return HttpServerResponse.empty({ status: 101 });
  }).pipe(Effect.scoped, Effect.orDie) as HttpEffect;

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
] as const;

type DomainRpcs = (typeof rpcs)[number];

/**
 * The entity a domain model runs on: every aggregate instance, view key,
 * policy and projection key is one entity id of it
 * (`Bank.AccountAggregate/a-1`).
 */
const entity = <const Type extends string>(type: Type): EffectEntity.Entity<Type, DomainRpcs> =>
  EffectEntity.make(type, rpcs);

/** Built for one entity id: an object's methods. */
type InstanceBuild = Effect.Effect<
  Record<string, unknown>,
  never,
  ObjectState | RuntimeContext | Scope.Scope
>;

/** Where every instance keeps its storage: one row per key, in the cluster's database. */
const TABLE = "alchemy_domain_objects";

const encode = (value: unknown) => JSON.stringify(value ?? null);
const decode = <T>(text: string) => JSON.parse(text) as T;

/**
 * Domain's storage for one entity id over the cluster's Postgres. Every
 * operation goes through the instance's input gate, as on Cloudflare.
 */
const objectStorage = (sql: SqlClient, object: string, gate: InputGateShape): ObjectStorage => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => gate.storage(Effect.orDie(effect));
  const putOne = (key: string, value: unknown) =>
    sql`INSERT INTO ${sql(TABLE)} (object, key, value) VALUES (${object}, ${key}, ${encode(value)})
        ON CONFLICT (object, key) DO UPDATE SET value = excluded.value`;
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
        typeof keyOrEntries === "string"
          ? Effect.asVoid(putOne(keyOrEntries, value))
          : Effect.forEach(Object.entries(keyOrEntries), ([key, entry]) => putOne(key, entry), {
              discard: true,
            }),
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
    // Held across the whole transaction, as Cloudflare's gate is.
    transaction: (effect) =>
      gate.exclusive(sql.withTransaction(effect).pipe(Effect.orDie)) as never,
  };
};

/** Create the storage table, once per runner. */
const migrate = (sql: SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
    object TEXT COLLATE "C" NOT NULL,
    key TEXT COLLATE "C" NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (object, key)
  )`.pipe(Effect.orDie);

/** A Domain host entity was asked for an object of a class it doesn't host. */
export class DomainClassNotHosted extends Data.TaggedError("Cluster.DomainClassNotHosted")<{
  readonly message: string;
}> {}

/** A saga's workflow engine was used before the runner joined the cluster. */
export class DomainEngineNotStarted extends Data.TaggedError("Cluster.DomainEngineNotStarted")<{
  readonly message: string;
}> {}

/** The class names each host entity claims, by type. */
const claims = new Map<string, object>();
const claimOf = (type: string) => {
  let claim = claims.get(type);
  if (claim === undefined) claims.set(type, (claim = {}));
  return claim;
};

/** The object of every saga's runs, reached from outside the cluster. */
const WORKFLOWS = "~workflows";

/** Calls to one entity id's object, as Domain's stubs. */
const remote =
  (namespace: EntityNamespace<DomainRpcs>) =>
  (cls: string): Namespace => ({
    getByName: (key: string) =>
      new Proxy(
        {},
        {
          get: (_, method) =>
            method === LIVE_METHOD
              ? (attachment: string) =>
                  Stream.unwrap(
                    Effect.map(namespace.getByName(`${cls}/${key}`), (client) =>
                      client.Live({ attachment }),
                    ),
                  )
              : (...args: ReadonlyArray<unknown>) =>
                  Effect.flatMap(namespace.getByName(`${cls}/${key}`), (client) =>
                    client
                      .Call({ method: String(method), args: JSON.stringify(args) })
                      .pipe(Effect.map((result) => JSON.parse(result) as unknown)),
                  ),
        },
      ) as never,
  });

/**
 * The workflow engine a model's sagas run on, for code outside the
 * cluster: runs start, are read and are signalled through the host entity,
 * which runs them on Effect Cluster's own engine.
 */
const remoteEngine = (workflows: Namespace): WorkflowEngine.WorkflowEngine["Service"] => {
  const stub = (workflow: Workflow.Any) => workflows.getByName(workflow._tag);
  const call = <A>(effect: Effect.Effect<unknown, unknown>) =>
    effect.pipe(Effect.orDie) as Effect.Effect<A>;
  const outside = (what: string) =>
    Effect.die(
      new DomainEngineNotStarted({
        message: `A saga's ${what} runs only inside the cluster that hosts its model.`,
      }),
    );
  return WorkflowEngine.WorkflowEngine.of({
    register: () => Effect.void,
    execute: ((
      workflow: Workflow.Any,
      options: { executionId: string; payload: unknown; discard?: boolean },
    ) =>
      Effect.gen(function* () {
        const any = workflow as Workflow.AnyWithProps;
        const payload = yield* Schema.encodeEffect(payloadCodec(any))(options.payload).pipe(
          Effect.orDie,
        );
        const result = yield* call<string | null>(
          stub(workflow).wfExecute(options.executionId, JSON.stringify(payload), !!options.discard),
        );
        if (options.discard) return options.executionId;
        if (result === null) return yield* Effect.die(new Error("suspended"));
        const complete = yield* decodeResult(any, result);
        return yield* complete.exit;
      })) as never,
    poll: ((workflow: Workflow.Any, executionId: string) =>
      Effect.gen(function* () {
        const polled = yield* call<{ started: boolean; result: string | null }>(
          stub(workflow).wfPoll(executionId),
        );
        if (!polled.started) return Option.none();
        if (polled.result === null) return Option.some(Workflow.Suspended.make({}));
        return Option.some(yield* decodeResult(workflow as Workflow.AnyWithProps, polled.result));
      })) as never,
    interrupt: (workflow, executionId) => call(stub(workflow).wfInterrupt(executionId)),
    interruptUnsafe: (workflow, executionId) => call(stub(workflow).wfInterruptUnsafe(executionId)),
    resume: (workflow, executionId) => call(stub(workflow).wfResume(executionId)),
    deferredDone: ((
      deferred: DurableDeferred.DurableDeferred<Schema.Top, Schema.Top>,
      options: {
        workflowName: string;
        executionId: string;
        deferredName: string;
        exit: Exit.Exit<unknown, unknown>;
      },
    ) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(
          deferred.exitSchema as unknown as Schema.Codec<unknown, unknown>,
        )(options.exit).pipe(Effect.orDie);
        yield* call(
          workflows
            .getByName(options.workflowName)
            .wfSignal(options.executionId, options.deferredName, JSON.stringify(encoded)),
        );
      })) as never,
    activityExecute: () => outside("step"),
    deferredResult: () => outside("wait"),
    scheduleClock: () => outside("sleep"),
  });
};

/** A deferred left to Effect Cluster's engine to encode: its value arrives already encoded. */
const encodedDeferred = (name: string) =>
  DurableDeferred.make(name, { success: Schema.Unknown, error: Schema.Unknown });

/**
 * The `~workflows/<name>` object: what {@link remoteEngine} asks of the
 * cluster's engine, by workflow name.
 */
const workflowsObject = (
  workflows: ReadonlyMap<string, Workflow.Any>,
  engine: Effect.Effect<WorkflowEngine.WorkflowEngine["Service"]>,
): InstanceBuild =>
  Effect.succeed({
    wfExecute: (executionId: string, payload: string, _discard: boolean) =>
      Effect.gen(function* () {
        const workflow = workflows.get(yield* workflowName) as Workflow.AnyWithProps;
        const decoded = yield* Schema.decodeEffect(payloadCodec(workflow))(
          JSON.parse(payload),
        ).pipe(Effect.orDie);
        yield* (yield* engine).execute(workflow as never, {
          executionId,
          payload: decoded as never,
          discard: true,
        });
        // The run starts; callers that wait poll it.
        const polled = yield* (yield* engine).poll(workflow as never, executionId);
        return Option.isSome(polled) && polled.value._tag === "Complete"
          ? yield* encodeResult(workflow, polled.value.exit as Exit.Exit<unknown, unknown>)
          : null;
      }),
    wfPoll: (executionId: string) =>
      Effect.gen(function* () {
        const workflow = workflows.get(yield* workflowName) as Workflow.AnyWithProps;
        const polled = yield* (yield* engine).poll(workflow as never, executionId);
        if (Option.isNone(polled)) return { started: false, result: null };
        return {
          started: true,
          result:
            polled.value._tag === "Complete"
              ? yield* encodeResult(workflow, polled.value.exit as Exit.Exit<unknown, unknown>)
              : null,
        };
      }),
    wfInterrupt: (executionId: string) =>
      Effect.flatMap(Effect.all([workflowName, engine]), ([name, engine]) =>
        engine.interrupt(workflows.get(name)!, executionId),
      ),
    wfInterruptUnsafe: (executionId: string) =>
      Effect.flatMap(Effect.all([workflowName, engine]), ([name, engine]) =>
        engine.interruptUnsafe(workflows.get(name)!, executionId),
      ),
    wfResume: (executionId: string) =>
      Effect.flatMap(Effect.all([workflowName, engine]), ([name, engine]) =>
        engine.resume(workflows.get(name)!, executionId),
      ),
    wfSignal: (executionId: string, deferredName: string, exit: string) =>
      Effect.gen(function* () {
        const deferred = encodedDeferred(deferredName);
        const decoded = yield* Schema.decodeEffect(
          deferred.exitSchema as unknown as Schema.Codec<unknown, unknown>,
        )(JSON.parse(exit)).pipe(Effect.orDie);
        yield* (yield* engine).deferredDone(deferred, {
          workflowName: yield* workflowName,
          executionId,
          deferredName,
          exit: decoded as Exit.Exit<unknown, unknown>,
        });
      }),
  });

/** The workflow a `~workflows/<name>` object serves: its key. */
const workflowName = Effect.map(EffectEntity.CurrentAddress, (address) =>
  address.entityId.slice(WORKFLOWS.length + 1),
);

/** Options for {@link layerEntities}. */
export interface EntitiesOptions<PoolReq> {
  /** The entity that hosts the model: its type in the cluster. */
  readonly name: string;
  /**
   * The module that exports the model's Layer (the one this platform is
   * provided to), usually `import.meta.url`. The pool's runners load it to
   * run the model.
   */
  readonly main: string;
  /**
   * The export of {@link main} that holds the model's Layer.
   * @default "default"
   */
  readonly handler?: string;
  /** The pool whose runners run the model, e.g. `ClusterDocker.SwarmPool("Default")`. */
  readonly pool: PoolLayer<PoolReq>;
}

/**
 * Host a domain model on Effect Cluster entities. Provide it to the model's
 * Layer, as `Domain.InMemory` or `DomainCloudflare.layerDurableObjects()` would be, in
 * every runtime that serves the model: a container, a Lambda, a Worker.
 *
 * The model's aggregate instances, view keys, policies and projection keys
 * are entity ids of one entity, `name`, each named after what it holds
 * (`Bank.AccountAggregate/a-1`). Built in a caller, the Layer deploys that
 * entity to `pool` and reaches it through the pool's gateway. The pool's
 * runners load the model's Layer from `main`, and there the same Layer
 * hosts the entity.
 *
 * Commands to one aggregate instance run one at a time, through each
 * instance's input gate. Every instance's events, state and outbox live in
 * the cluster's Postgres, in one table, and commit together. Scheduled
 * commands and retries are persisted messages delivered when they are due.
 * The model's sagas run on Effect Cluster's workflow engine. Over
 * `Domain.protocolWebSocket`, the caller holds a live read's WebSocket and
 * the instance that owns the key pushes every commit to it, over a
 * streamed call through the pool's gateway. Over `Domain.protocolHttp`,
 * live reads are streamed responses that poll the owning instance.
 *
 * ### Hosting a model on Effect Cluster
 * **Example:** The model's Layer, served from a container
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
 * import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const Database = ClusterDocker.Database("Cluster");
 * const Default = ClusterDocker.SwarmPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(
 *     DomainCluster.layerEntities({
 *       name: "Bank",
 *       main: import.meta.url,
 *       handler: "BankLive",
 *       pool: Default,
 *     }),
 *   ),
 * );
 *
 * export default class BankApi extends Docker.Service<BankApi>()(
 *   "BankApi",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layerEntities = <PoolReq>(
  options: EntitiesOptions<PoolReq>,
): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
  never,
  PoolReq | Providers
> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the entity is declared dynamically; its requirements are the pool's and the providers'
  Layer.unwrap(
    Effect.gen(function* () {
      const name = options.name;
      // In this pool's shard group, as the runner registers its entities.
      const shardGroup = () =>
        (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
          .CLUSTER_SHARD_GROUPS ?? "default";
      const objects = entity(name).annotate(ClusterSchema.ShardGroup, shardGroup);
      // The sagas' runs too: a run is routed by its workflow's shard group.
      const placed = <W extends Workflow.Any>(workflow: W): W =>
        Object.create(workflow, {
          annotations: {
            value: Context.add(workflow.annotations, ClusterSchema.ShardGroup, shardGroup),
            enumerable: true,
          },
        });
      const classes = new Map<string, InstanceBuild>();
      const workflows = new Map<string, Workflow.Any>();
      // Lives as long as the runner: the model's Layer is the entity's.
      const scope = yield* Scope.make();
      // One Postgres pool per runner, opened on the first instance.
      const sql = yield* Effect.cached(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("CLUSTER_DATABASE_URL").pipe(Effect.orDie);
          const context = yield* Layer.buildWithScope(PgClient.layer({ url }), scope).pipe(
            Effect.orDie,
          );
          const client = Context.get(context, SqlClient);
          yield* migrate(client);
          return client;
        }),
      );
      // Completed once the runner has joined the cluster; a call made
      // before then waits for it.
      const engine = yield* Deferred.make<WorkflowEngine.WorkflowEngine["Service"]>();
      const started = Deferred.await(engine);
      classes.set(WORKFLOWS, workflowsObject(workflows, started));

      // Each instance builds the object its entity id says.
      const instance = Effect.gen(function* () {
        const address = yield* EffectEntity.CurrentAddress;
        const id = address.entityId;
        const parsed = id.startsWith(`${WORKFLOWS}/`)
          ? { className: WORKFLOWS, key: id.slice(WORKFLOWS.length + 1) }
          : parseMultiplexedName(id);
        const build = parsed === undefined ? undefined : classes.get(parsed.className);
        if (build === undefined) {
          return yield* Effect.die(
            new DomainClassNotHosted({
              message: `Cluster.Entity '${name}' hosts no Domain class for '${id}'.`,
            }),
          );
        }
        const gate = yield* makeInputGate;
        // The instance's own object where the pool gives it one; otherwise
        // its rows in the cluster's Postgres.
        const native = yield* Effect.serviceOption(InstanceStorage);
        // A Durable Object's storage has Cloudflare's input gate already, so it
        // doesn't go through this one: a transaction's callback runs in a
        // fiber of its own, which this gate would hold behind the transaction.
        const storage: ObjectStorage = Option.isSome(native)
          ? native.value
          : objectStorage(yield* sql, `${name}/${id}`, gate);
        const instanceScope = yield* Scope.Scope;
        const wakes = yield* objects.client;
        const callbacks = alarmCallbacks(storage, {
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
            all: () => Effect.sync(() => [...open.keys()]),
          },
        };
        const runtime = yield* RuntimeContext;
        const record = yield* build.pipe(
          Effect.provideService(ObjectState, state),
          Effect.provideService(RuntimeContext, {
            ...runtime,
            makeCallback: callbacks.makeCallback,
          }),
        );
        return objects.of({
          Call: ({ payload }) =>
            gate.call(
              Effect.suspend(() => {
                const method = record[payload.method];
                return typeof method === "function"
                  ? (method as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                      ...(JSON.parse(payload.args) as ReadonlyArray<unknown>),
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
                    headers: { upgrade: "websocket", [SUBSCRIPTION_HEADER]: payload.attachment },
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
          handler: options.handler ?? "default",
          // The model's objects call each other, and a call can come back to
          // the instance that made it; each instance's input gate keeps its
          // storage consistent.
          concurrency: "unbounded",
        },
        Effect.succeed(instance).pipe(Effect.provide(options.pool)),
      );

      const runner = yield* Effect.serviceOption(RunnerHost);
      if (Option.isSome(runner)) {
        // A runner of the pool: host the entity, as the bootstrap hosts an
        // exported one, with the classes the model declares here.
        const context = yield* Layer.build(entrypointLayer(Objects[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as EntityRuntimeContext
        ).hosted();
        if (hosted === undefined) {
          return yield* Effect.die(
            new HasNoPool({ message: `${name} did not finish its Construction phase.` }),
          );
        }
        const registrations = yield* Ref.make<
          ReadonlyArray<
            readonly [Workflow.Any, (payload: any, id: string) => Effect.Effect<any, any, any>]
          >
        >([]);
        // Sagas register while the model's Layer builds, before the runner
        // joins the cluster: hold them until then, then run every call on its engine.
        yield* runner.value.host(
          hosted,
          Effect.gen(function* () {
            const clusterEngine = yield* WorkflowEngine.WorkflowEngine;
            for (const [workflow, execute] of yield* Ref.get(registrations))
              yield* clusterEngine.register(workflow as never, execute as never);
            yield* Deferred.succeed(engine, clusterEngine);
          }).pipe(Layer.effectDiscard),
        );
        const deferredEngine = WorkflowEngine.WorkflowEngine.of({
          register: ((
            workflow: Workflow.Any,
            execute: (payload: any, id: string) => Effect.Effect<any, any, any>,
          ) =>
            Effect.andThen(
              Effect.sync(() => workflows.set(workflow._tag, placed(workflow))),
              Ref.update(registrations, (all) => [...all, [placed(workflow), execute] as const]),
            )) as never,
          execute: ((workflow: any, opts: any) =>
            Effect.flatMap(started, (engine) => engine.execute(placed(workflow), opts))) as never,
          poll: ((workflow: any, id: string) =>
            Effect.flatMap(started, (engine) => engine.poll(placed(workflow), id))) as never,
          interrupt: (workflow, id) =>
            Effect.flatMap(started, (engine) => engine.interrupt(placed(workflow), id)),
          interruptUnsafe: (workflow, id) =>
            Effect.flatMap(started, (engine) => engine.interruptUnsafe(placed(workflow), id)),
          resume: (workflow, id) =>
            Effect.flatMap(started, (engine) => engine.resume(placed(workflow), id)),
          activityExecute: ((activity: any, attempt: number) =>
            Effect.flatMap(started, (engine) =>
              engine.activityExecute(activity, attempt),
            )) as never,
          deferredResult: ((deferred: any) =>
            Effect.flatMap(started, (engine) => engine.deferredResult(deferred))) as never,
          deferredDone: ((deferred: any, opts: any) =>
            Effect.flatMap(started, (engine) => engine.deferredDone(deferred, opts))) as never,
          scheduleClock: (workflow, opts) =>
            Effect.flatMap(started, (engine) => engine.scheduleClock(placed(workflow), opts)),
        });
        // Inside the cluster, calls route through Effect Cluster itself.
        const self = remote(
          makeNamespace(objects as never, { url: "", token: "", service: "" }) as never,
        );
        const host: Host = {
          declare: ({ modelName }, cls, impl: ObjectImpl) =>
            Effect.sync(() => {
              classes.set(className(modelName, cls), impl);
              return self(className(modelName, cls));
            }),
          lookup: ({ modelName }, cls) => self(className(modelName, cls)),
          connect: connectTo,
          claimKey: Effect.succeed(claimOf(name)),
        };
        return Layer.merge(
          makePlatform(host),
          Layer.succeed(WorkflowEngine.WorkflowEngine, deferredEngine),
        ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
      }

      // A caller: deploy the entity, and reach it through the gateway.
      const self = remote((yield* Objects) as EntityNamespace<DomainRpcs>);
      const host: Host = {
        declare: ({ modelName }, cls) => Effect.succeed(self(className(modelName, cls))),
        lookup: ({ modelName }, cls) => self(className(modelName, cls)),
        connect: connectTo,
        claimKey: Effect.succeed(claimOf(name)),
      };
      return Layer.merge(
        makePlatform(host),
        Layer.succeed(WorkflowEngine.WorkflowEngine, remoteEngine(self(WORKFLOWS))),
      ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
    }),
  ) as Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
    never,
    PoolReq | Providers
  >;
