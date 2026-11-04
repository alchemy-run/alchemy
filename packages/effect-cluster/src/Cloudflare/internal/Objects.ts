/**
 * Effect Cluster on Durable Objects, in Effect's shape: there are no shards
 * or runners to place an instance on, because a Durable Object already is one
 * instance per name. Every entity type shares one class, `ClusterEntity`,
 * whose objects are named by `(type, id)`; every workflow shares
 * `ClusterWorkflow`, one object per execution; every singleton and cron
 * shares `ClusterScheduled`, one object per name.
 *
 * `Sharding` is the seam: Effect Cluster's own client (`Entity.client`), the
 * gateway and one entity calling another all ask it for a client, and this
 * one sends each call to the entity's object.
 *
 * @internal
 */
import * as Cloudflare from "@alchemy.run/cloudflare/Workers";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine, type ObjectImpl } from "alchemy/Workers/DurableObjectEngine";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import {
  ClusterCron,
  ClusterSchema,
  type Entity as EffectEntity,
  EntityAddress,
  EntityId,
  EntityType,
  Envelope,
  RunnerAddress,
  Sharding,
  ShardId,
  Snowflake,
} from "effect/cluster";
import { CurrentAddress, CurrentRunnerAddress } from "effect/cluster/Entity";
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as PrimaryKey from "effect/PrimaryKey";
import * as Queue from "effect/Queue";
import { Rpc, RpcClient, RpcSchema } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { HostedCron } from "../../Cron.ts";
import type { HostedEntity } from "../../Entity.ts";
import type { HostedSingleton } from "../../Singleton.ts";

type AnyEntity = EffectEntity.Entity<string, Rpc.Any>;

/** A class this Worker hosts was asked for, but nothing registered it. */
export class NotHosted extends Data.TaggedError("Cluster.NotHosted")<{
  readonly message: string;
}> {}

/**
 * What the Worker's init registers, for the objects of this isolate to run:
 * each object reads the class it runs from here when it is constructed.
 */
export const registry = {
  entities: new Map<string, HostedEntity>(),
  scheduled: new Map<string, HostedSingleton | HostedCron>(),
  workflows: new Map<string, ObjectImpl<Cloudflare.DurableObjectState>>(),
  sharding: undefined as Sharding.Sharding["Service"] | undefined,
};

// ---------------------------------------------------------------- names

/** `(type, id)` as one object name, length-prefixed like Effect's: `7:Counter` + id. */
export const entityObjectName = (type: string, id: string) => `${type.length}:${type}${id}`;

const parseEntityObjectName = (name: string) => {
  const colon = name.indexOf(":");
  const length = Number(name.slice(0, colon));
  return {
    type: name.slice(colon + 1, colon + 1 + length),
    id: name.slice(colon + 1 + length),
  };
};

/** The object a workflow execution runs in: `${class}:${executionId}`. */
const workflowObjectName = (className: string, executionId: string) =>
  `${className}:${executionId}`;

/** The object a singleton or cron runs in: `singleton:${name}` or `cron:${name}`. */
export const scheduledObjectName = (kind: "singleton" | "cron", name: string) => `${kind}:${name}`;

const objectName = (state: Cloudflare.DurableObjectState["Service"]) => state.id.name ?? "";

// ---------------------------------------------------------------- wire

/** One call to an entity, as it crosses to the entity's object. */
interface Call {
  readonly requestId: string;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: Record<string, string>;
}

/** A failure of the object itself, returned as data: Workers RPC hides thrown errors. */
const DEFECT = "~cluster/defect";

const json = <S extends Schema.Top>(schema: S) =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>;

const payloadCodec = (rpc: Rpc.AnyWithProps) => json(rpc.payloadSchema);
const exitCodec = (rpc: Rpc.AnyWithProps) => json(Rpc.exitSchema(rpc as Rpc.Any));
const chunkCodec = (rpc: Rpc.AnyWithProps) =>
  json(RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : Schema.Unknown);

const encode = (codec: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.encodeUnknownEffect(codec)(value).pipe(Effect.orDie);
const decode = (codec: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.decodeUnknownEffect(codec)(value).pipe(Effect.orDie);

const rpcOf = (entity: AnyEntity, tag: string) => {
  const rpc = entity.protocol.requests.get(tag) as Rpc.AnyWithProps | undefined;
  return rpc === undefined
    ? Effect.die(new NotHosted({ message: `Entity '${entity.type}' has no RPC '${tag}'.` }))
    : Effect.succeed(rpc);
};

/** Call an object, turning a defect it returned as data back into a defect. */
const call = <A>(effect: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DEFECT in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DEFECT])))
        : Effect.succeed(value as A),
    ),
  );

const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.succeed({ [DEFECT]: Cause.pretty(cause) } as unknown as A)),
  );

// ---------------------------------------------------------------- sharding

interface EntityObjectStub {
  readonly ask: (call: string) => Effect.Effect<string, unknown>;
  readonly tell: (call: string) => Effect.Effect<void, unknown>;
  readonly stream: (call: string) => Stream.Stream<string, unknown>;
}

interface Namespace<Stub> {
  readonly getByName: (name: string) => Stub;
}

let requests = 0;

/**
 * A client for one entity instance: each RPC is sent to the entity's object
 * and answered by it, with the caller's headers, as Effect Cluster's own
 * client sends it to the runner that owns the entity.
 */
const clientOf = (
  entity: AnyEntity,
  entityId: string,
  objects: () => Namespace<EntityObjectStub>,
) => {
  const methods: Record<string, unknown> = {};
  for (const [tag, rpc_] of entity.protocol.requests) {
    const rpc = rpc_ as unknown as Rpc.AnyWithProps;
    const message = Effect.fn(function* (
      payload: unknown,
      options?: { readonly headers?: Headers.Input },
    ) {
      const headers = Headers.merge(
        yield* RpcClient.CurrentHeaders,
        Headers.fromInput(options?.headers ?? {}),
      );
      return JSON.stringify({
        requestId: `${yield* Clock.currentTimeMillis}-${requests++}`,
        tag,
        payload: yield* encode(payloadCodec(rpc), payload),
        headers: Object.fromEntries(Object.entries(headers)),
      } satisfies Call);
    });
    const stub = () => objects().getByName(entityObjectName(entity.type, entityId));
    methods[tag] = RpcSchema.isStreamSchema(rpc.successSchema)
      ? (payload: unknown, options?: { readonly headers?: Headers.Input }) =>
          Stream.unwrap(
            Effect.map(message(payload, options), (sent) =>
              stub()
                .stream(sent)
                .pipe(
                  Stream.orDie,
                  Stream.mapEffect((frame) => decodeFrame(rpc, frame)),
                  Stream.flatMap((values) => Stream.fromIterable(values)),
                ),
            ),
          )
      : (
          payload: unknown,
          options?: { readonly discard?: boolean; readonly headers?: Headers.Input },
        ) =>
          Effect.gen(function* () {
            const sent = yield* message(payload, options);
            if (options?.discard === true) return yield* call<void>(stub().tell(sent));
            const reply = yield* call<string>(stub().ask(sent));
            const exit = (yield* decode(exitCodec(rpc), JSON.parse(reply))) as Exit.Exit<
              unknown,
              unknown
            >;
            return yield* exit;
          });
  }
  return methods;
};

/** A stream frame: `{ chunk }` values, or the stream's `{ exit }`. */
const decodeFrame = Effect.fn(function* (rpc: Rpc.AnyWithProps, frame: string) {
  const parsed = JSON.parse(frame) as { chunk?: unknown[]; exit?: unknown; [DEFECT]?: string };
  if (parsed[DEFECT] !== undefined) return yield* Effect.die(new Error(parsed[DEFECT]));
  if (parsed.chunk !== undefined) {
    return yield* Effect.forEach(parsed.chunk, (value) => decode(chunkCodec(rpc), value));
  }
  const exit = (yield* decode(exitCodec(rpc), parsed.exit)) as Exit.Exit<unknown, unknown>;
  yield* exit;
  return [];
});

const notOnCloudflare = (operation: string) =>
  Effect.die(new NotHosted({ message: `Sharding.${operation} is not used on Durable Objects.` }));

/** `Sharding` for a Worker whose entities are Durable Objects. */
export const makeObjectSharding = (
  objects: () => Namespace<EntityObjectStub>,
): Sharding.Sharding["Service"] =>
  ({
    getShardId: (_entityId: string, group: string) => ShardId.make(group, 1),
    hasShardId: () => true,
    getSnowflake: Effect.map(Clock.currentTimeMillis, (now) =>
      Snowflake.Snowflake(BigInt(now) << 22n),
    ),
    isShutdown: Effect.succeed(false),
    makeClient: (entity: AnyEntity) =>
      Effect.succeed((entityId: string) => clientOf(entity, entityId, objects)),
    getRegistrationEvents: Stream.empty,
    registerEntity: () => notOnCloudflare("registerEntity"),
    registerSingleton: () => notOnCloudflare("registerSingleton"),
    send: () => notOnCloudflare("send"),
    sendOutgoing: () => notOnCloudflare("sendOutgoing"),
    notify: () => notOnCloudflare("notify"),
    reset: () => Effect.succeed(false),
    pollStorage: Effect.void,
    activeEntityCount: Effect.succeed(registry.entities.size),
  }) as unknown as Sharding.Sharding["Service"];

/** The services everything hosted runs with, beyond its own: the cluster's `Sharding`. */
const withSharding = (context: Context.Context<never>) =>
  registry.sharding === undefined
    ? context
    : Context.add(context, Sharding.Sharding, registry.sharding);

// ---------------------------------------------------------------- SQL

type Row = Record<string, string | number | null>;

const sqlOf = (
  state: Cloudflare.DurableObjectState["Service"],
  runtime: Context.Context<RuntimeContext>,
) => ({
  query: <T extends Row>(sql: string, ...bindings: ReadonlyArray<unknown>) =>
    state.storage.sql.exec<T>(sql, ...bindings).pipe(
      Effect.flatMap((cursor) => cursor.toArray()),
      Effect.provide(runtime),
    ) as Effect.Effect<ReadonlyArray<T>>,
  setAlarm: (at: number) => state.storage.setAlarm(at).pipe(Effect.provide(runtime)),
});

// ---------------------------------------------------------------- entities

/** How long a persisted message waits before its object replays it, after a restart. */
const REPLAY_AFTER = 30_000;

/**
 * How often an instance's alarm wakes its object while the instance may not
 * stop yet: Cloudflare evicts an object idle for about ten seconds, and the
 * instance's state with it.
 */
const KEEP_AWAKE = 5_000;

/**
 * Every entity instance: one object per `(type, id)`. The first message
 * builds the instance's handlers; messages run one at a time unless the
 * entity allows more. A persisted message is stored before it runs and its
 * reply after, so a primary key runs once, and one cut short by a restart
 * runs again when the object's alarm fires. Like on runners, an instance
 * keeps its state until it has been idle for `maxIdleTime`: its alarm keeps
 * the object awake until then.
 */
export const EntityObject = Cloudflare.DurableObject<EntityObjectStub>()(
  "ClusterEntity",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const runtime = yield* Effect.context<RuntimeContext>();
      const { type, id } = parseEntityObjectName(objectName(state));
      const hosted = registry.entities.get(type);
      if (hosted === undefined) {
        return yield* Effect.die(
          new NotHosted({ message: `This Worker hosts no Cluster.Entity '${type}'.` }),
        );
      }
      const { query, setAlarm } = sqlOf(state, runtime);
      yield* query(
        "CREATE TABLE IF NOT EXISTS cluster_messages (request_id TEXT PRIMARY KEY, call TEXT NOT NULL, exit TEXT)",
      );

      const address = EntityAddress.make({
        shardId: ShardId.make("cloudflare", 1),
        entityType: EntityType.make(type),
        entityId: EntityId.make(id),
      });
      const context = Context.add(withSharding(hosted.context), CurrentAddress, address);
      // The instance lives as long as its object; workerd has no teardown hook.
      const instanceScope = Scope.makeUnsafe();
      const handlers = yield* Effect.cached(
        hosted.instance.pipe(
          Effect.provideService(Scope.Scope, instanceScope),
          Effect.provideService(CurrentRunnerAddress, RunnerAddress.make(objectName(state), 0)),
          Effect.provideContext(Context.merge(context, runtime)),
        ) as Effect.Effect<Record<string, (request: unknown) => unknown>>,
      );
      const maxIdle = Duration.toMillis(
        Duration.fromInputUnsafe(hosted.options.maxIdleTime ?? "1 minute"),
      );
      let lastActive = yield* Clock.currentTimeMillis;
      let armedAt = 0;
      /** Wake the object at `at`, unless it already wakes sooner. */
      const arm = (at: number) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => {
          if (armedAt > now && armedAt <= at) return Effect.void;
          armedAt = at;
          return setAlarm(at);
        });
      /** A message arrived: keep the instance until it has been idle for `maxIdleTime`. */
      const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => {
        lastActive = now;
        return arm(lastActive + KEEP_AWAKE);
      });
      const concurrency = hosted.options.concurrency ?? 1;
      const permits = Semaphore.makeUnsafe(
        concurrency === "unbounded" ? Number.MAX_SAFE_INTEGER : concurrency,
      );

      /** The handler's result for `request`, with the RPC's middleware around it. */
      const handle = Effect.fn(function* (rpc: Rpc.AnyWithProps, request: Call, payload: unknown) {
        const handler = (yield* handlers)[rpc._tag];
        const headers = Headers.fromInput(request.headers);
        const requestId = Snowflake.Snowflake(BigInt(requests++));
        const envelope = Envelope.makeRequest<Rpc.Any>({
          requestId,
          address,
          tag: rpc._tag as never,
          payload: payload as never,
          headers,
        });
        return { result: handler!(envelope), requestId, headers };
      });

      const withMiddleware = <A, E, R>(
        rpc: Rpc.AnyWithProps,
        effect: Effect.Effect<A, E, R>,
        options: { readonly requestId: Snowflake.Snowflake; readonly headers: Headers.Headers },
        payload: unknown,
      ) => {
        let wrapped = effect as Effect.Effect<any, any, any>;
        for (const middleware of rpc.middlewares) {
          const run = Context.getUnsafe(context, middleware) as (
            effect: Effect.Effect<any, any, any>,
            options: object,
          ) => Effect.Effect<any, any, any>;
          wrapped = run(wrapped, {
            rpc,
            client: new Rpc.ServerClient(0),
            requestId: options.requestId,
            headers: options.headers,
            payload,
          });
        }
        return wrapped.pipe(Effect.provideContext(Context.merge(context, runtime)));
      };

      /** Run one call to an Effect RPC and encode its exit. */
      const run = Effect.fn(function* (request: Call) {
        yield* touch;
        const rpc = yield* rpcOf(hosted.entity, request.tag);
        const payload = yield* decode(payloadCodec(rpc), request.payload);
        const persisted = Context.get(rpc.annotations, ClusterSchema.Persisted);
        const key = PrimaryKey.isPrimaryKey(payload)
          ? `${rpc._tag}/${PrimaryKey.value(payload)}`
          : request.requestId;
        if (persisted) {
          const [stored] = yield* query<{ exit: string | null }>(
            "SELECT exit FROM cluster_messages WHERE request_id = ?",
            key,
          );
          if (stored?.exit != null) return stored.exit;
          if (stored === undefined) {
            yield* query(
              "INSERT INTO cluster_messages (request_id, call) VALUES (?, ?)",
              key,
              JSON.stringify(request),
            );
          }
          yield* arm((yield* Clock.currentTimeMillis) + REPLAY_AFTER);
        }
        const { result, requestId, headers } = yield* handle(rpc, request, payload);
        const exit = yield* Effect.exit(
          withMiddleware(
            rpc,
            result as Effect.Effect<unknown, unknown>,
            { requestId, headers },
            payload,
          ),
        );
        const encoded = JSON.stringify(yield* encode(exitCodec(rpc), exit));
        if (persisted) {
          yield* query("UPDATE cluster_messages SET exit = ? WHERE request_id = ?", encoded, key);
        }
        return encoded;
      });

      /** Run one call to a streaming RPC, framing its values and its end. */
      const stream = (request: Call) =>
        Stream.callback<string>((queue) =>
          Effect.gen(function* () {
            yield* touch;
            const rpc = yield* rpcOf(hosted.entity, request.tag);
            const payload = yield* decode(payloadCodec(rpc), request.payload);
            const { result, requestId, headers } = yield* handle(rpc, request, payload);
            const values = Effect.isEffect(result)
              ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a streaming handler returns its RPC's stream, or an Effect of it
                Stream.unwrap(result as Effect.Effect<Stream.Stream<unknown, unknown>>)
              : (result as Stream.Stream<unknown, unknown>);
            const forward = Stream.runForEachArray(values, (chunk) =>
              Effect.flatMap(
                Effect.forEach(chunk, (value) => encode(chunkCodec(rpc), value)),
                (encoded) => Queue.offer(queue, JSON.stringify({ chunk: encoded })),
              ),
            );
            const exit = yield* Effect.exit(
              withMiddleware(rpc, forward, { requestId, headers }, payload),
            );
            const encoded = yield* encode(exitCodec(rpc), Exit.asVoid(exit));
            yield* Queue.offer(queue, JSON.stringify({ exit: encoded }));
            yield* Queue.end(queue);
          }).pipe(
            permits.withPermits(1),
            Effect.catchCause((cause) =>
              Effect.andThen(
                Queue.offer(queue, JSON.stringify({ [DEFECT]: Cause.pretty(cause) })),
                Queue.end(queue),
              ),
            ),
          ),
        );

      /**
       * Replay the persisted messages a restart cut short, then wake again
       * while the instance may not stop yet, or while messages wait.
       */
      const wake = Effect.gen(function* () {
        armedAt = 0;
        const pending = yield* query<{ call: string }>(
          "SELECT call FROM cluster_messages WHERE exit IS NULL",
        );
        for (const row of pending) {
          yield* run(JSON.parse(row.call) as Call).pipe(permits.withPermits(1), Effect.ignore);
        }
        const now = yield* Clock.currentTimeMillis;
        if (now - lastActive < maxIdle) return yield* arm(now + KEEP_AWAKE);
        const [waiting] = yield* query("SELECT 1 FROM cluster_messages WHERE exit IS NULL LIMIT 1");
        if (waiting !== undefined) yield* arm(now + REPLAY_AFTER);
      });

      return {
        ask: (message: string) =>
          reportDefects(run(JSON.parse(message) as Call).pipe(permits.withPermits(1))),
        // The caller doesn't wait: the call runs after this returns, and the
        // object stays alive until it finishes.
        tell: (message: string) =>
          reportDefects(
            state.waitUntil(
              run(JSON.parse(message) as Call).pipe(permits.withPermits(1), Effect.ignore),
            ),
          ),
        stream: (message: string) => stream(JSON.parse(message) as Call),
        alarm: () => wake.pipe(Effect.ignoreCause),
      };
    });
  }),
);

// ---------------------------------------------------------------- singletons and crons

interface ScheduledObjectStub {
  readonly ensure: () => Effect.Effect<void, unknown>;
}

/** How often a singleton's object checks that it is still running. */
const SINGLETON_HEARTBEAT = 10_000;

/**
 * Every singleton and cron: one object per name, kept awake by its alarm. A
 * singleton's object runs its fiber and checks on it every few seconds,
 * restarting it if its object was restarted; a cron's object wakes at each
 * scheduled time and runs the job once.
 */
export const ScheduledObject = Cloudflare.DurableObject<ScheduledObjectStub>()(
  "ClusterScheduled",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const runtime = yield* Effect.context<RuntimeContext>();
      const name = objectName(state);
      const colon = name.indexOf(":");
      const hosted = registry.scheduled.get(name.slice(colon + 1));
      if (hosted === undefined) {
        return yield* Effect.die(
          new NotHosted({ message: `This Worker hosts no singleton or cron '${name}'.` }),
        );
      }
      const { query, setAlarm } = sqlOf(state, runtime);
      yield* query(
        "CREATE TABLE IF NOT EXISTS cluster_schedule (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      );
      const context = Context.merge(withSharding(hosted.context), runtime);

      if (hosted.kind === "singleton") {
        let fiber: Fiber.Fiber<unknown, unknown> | undefined;
        const beat = Effect.gen(function* () {
          if (fiber === undefined || fiber.pollUnsafe() !== undefined) {
            fiber = Effect.runForkWith(context)(
              hosted.run.pipe(
                Effect.andThen(Effect.never),
                Effect.scoped,
                Effect.tapCause((cause) => Effect.logError("Singleton failed", cause)),
                // The object's next heartbeat starts it again.
                Effect.ignore,
              ),
            );
          }
          yield* setAlarm((yield* Clock.currentTimeMillis) + SINGLETON_HEARTBEAT);
        });
        return { ensure: () => reportDefects(beat), alarm: () => beat };
      }

      const nextAfter = (time: number) => Cron.next(hosted.cron, new Date(time)).getTime();
      const readNext = Effect.map(
        query<{ value: number }>("SELECT value FROM cluster_schedule WHERE key = 'next'"),
        ([row]) => row?.value,
      );
      const writeNext = (next: number) =>
        Effect.andThen(
          query("INSERT OR REPLACE INTO cluster_schedule (key, value) VALUES ('next', ?)", next),
          setAlarm(next),
        );
      const fire = Effect.gen(function* () {
        const due = yield* readNext;
        const now = yield* Clock.currentTimeMillis;
        if (due === undefined) return yield* writeNext(nextAfter(now));
        if (due > now) return yield* setAlarm(due);
        // A run due longer ago than `skipIfOlderThan` (after an outage) is skipped.
        const skipAfter = hosted.options.skipIfOlderThan;
        const stale =
          skipAfter !== undefined &&
          now - due > Duration.toMillis(Duration.fromInputUnsafe(skipAfter));
        if (!stale) {
          yield* hosted.run.pipe(
            Effect.scoped,
            Effect.provideService(ClusterCron.CurrentScheduledTime, DateTime.makeUnsafe(due)),
            Effect.provideContext(context),
            Effect.tapCause((cause) => Effect.logError("Cron run failed", cause)),
            Effect.ignore,
          );
        }
        yield* writeNext(
          nextAfter(hosted.options.calculateNextRunFromPrevious ? due : Math.max(now, due)),
        );
      });
      const ensure = Effect.flatMap(readNext, (due) =>
        due === undefined ? writeNext(nextAfter(Date.now())) : Effect.void,
      );
      return { ensure: () => reportDefects(ensure), alarm: () => fire };
    });
  }),
);

// ---------------------------------------------------------------- workflows

/**
 * Every workflow execution: one object per `(workflow, execution)`, running
 * Alchemy's Durable Object workflow engine. The engine declares a class per
 * workflow; here each of those is a view onto this one class, so the Worker
 * exports the same classes whatever workflows it hosts.
 */
export const WorkflowObject = Cloudflare.DurableObject<Record<string, never>>()(
  "ClusterWorkflow",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const name = objectName(state);
      const className = name.slice(0, name.indexOf(":"));
      const impl = registry.workflows.get(className);
      if (impl === undefined) {
        return yield* Effect.die(
          new NotHosted({ message: `This Worker hosts no Cluster.Workflow '${className}'.` }),
        );
      }
      const object = yield* impl.pipe(Effect.provideService(Cloudflare.DurableObjectState, state));
      return (yield* object.pipe(
        Effect.provideService(Cloudflare.DurableObjectState, state),
      )) as Record<string, never>;
    });
  }),
);

/** The workflow engine, its executions on {@link WorkflowObject}. */
export const workflowEngine = (objects: () => Namespace<unknown>) =>
  makeDurableObjectEngine<never, Cloudflare.DurableObjectState>({
    declare: (className, impl) =>
      Effect.sync(() => {
        registry.workflows.set(className, impl);
        return {
          getByName: (executionId: string) =>
            objects().getByName(workflowObjectName(className, executionId)) as never,
        };
      }),
    state: Cloudflare.DurableObjectState,
  });
