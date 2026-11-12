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
  RunnerAddress,
  Sharding,
  ShardId,
  Snowflake,
} from "effect/cluster";
import {
  AlreadyProcessingMessage,
  MailboxFull,
  PersistenceError,
} from "effect/cluster/ClusterError";
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as Predicate from "effect/Predicate";
import { Rpc, RpcClient, RpcSchema } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HostedCron } from "../../Cron.ts";
import type { HostedEntity } from "../../Entity.ts";
import type { HostedSingleton } from "../../Singleton.ts";
import { makeEntityRuntime, type NativeStorage } from "./EntityRuntime.ts";
import {
  type Call,
  chunkCodec,
  DEFECT,
  decode,
  encode,
  entityObjectName,
  exitCodec,
  type Frame,
  parseEntityObjectName,
  payloadCodec,
  type Rejection,
  type Reply,
} from "./Wire.ts";

export { entityObjectName } from "./Wire.ts";

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

/** The object a workflow execution runs in: `${class}:${executionId}`. */
const workflowObjectName = (className: string, executionId: string) =>
  `${className}:${executionId}`;

/** The object a singleton or cron runs in: `singleton:${name}` or `cron:${name}`. */
export const scheduledObjectName = (kind: "singleton" | "cron", name: string) => `${kind}:${name}`;

const objectName = (state: Cloudflare.DurableObjectState["Service"]) => state.id.name ?? "";

// ---------------------------------------------------------------- wire

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
  readonly tell: (call: string) => Effect.Effect<string, unknown>;
  readonly stream: (call: string) => Stream.Stream<string, unknown>;
  readonly interrupt: (requestId: string) => Effect.Effect<void, unknown>;
}

interface Namespace<Stub> {
  readonly getByName: (name: string) => Stub;
}

/**
 * Whether a failed call to an object can be sent again: workerd marks a
 * transient failure `retryable`, and an `overloaded` object wants less
 * traffic, not more.
 */
const isRetryable = (error: unknown) =>
  Predicate.hasProperty(error, "cause") &&
  Predicate.hasProperty(error.cause, "retryable") &&
  error.cause.retryable === true &&
  !(Predicate.hasProperty(error.cause, "overloaded") && error.cause.overloaded === true);

/** A rejection the object answered with, as Effect Cluster's error. */
const rejectionError = (address: EntityAddress.EntityAddress, rejection: Rejection) => {
  switch (rejection._tag) {
    case "MailboxFull":
      return MailboxFull.make({ address });
    case "AlreadyProcessingMessage":
      return AlreadyProcessingMessage.make({ address, envelopeId: Snowflake.Snowflake(0) });
    case "PersistenceError":
      return PersistenceError.make({ cause: rejection.message });
  }
};

/**
 * A client for one entity instance: each RPC is sent to the entity's object
 * and answered by it, with the caller's headers, as Effect Cluster's own
 * client sends it to the runner that owns the entity.
 *
 * A call the object never answered fails with `PersistenceError`; a
 * persisted one is sent again first, to a fresh stub, since the object
 * stores it under the same request id and runs it once. Interrupting a call
 * interrupts its handler.
 */
const clientOf = (
  entity: AnyEntity,
  entityId: string,
  objects: () => Namespace<EntityObjectStub>,
) => {
  const address = EntityAddress.make({
    shardId: ShardId.make("cloudflare", 1),
    entityType: EntityType.make(entity.type),
    entityId: EntityId.make(entityId),
  });
  const stub = () => objects().getByName(entityObjectName(entity.type, entityId));
  const hosted = Effect.suspend(() =>
    registry.entities.has(entity.type)
      ? Effect.void
      : Effect.die(
          new NotHosted({ message: `This pool hosts no Cluster.Entity '${entity.type}'.` }),
        ),
  );
  const methods: Record<string, unknown> = {};
  for (const [tag, rpc_] of entity.protocol.requests) {
    const rpc = rpc_ as unknown as Rpc.AnyWithProps;
    const persisted = Context.get(rpc.annotations, ClusterSchema.Persisted);
    const message = Effect.fn(function* (
      payload: unknown,
      options?: { readonly headers?: Headers.Input },
    ) {
      yield* hosted;
      const headers = Headers.merge(
        yield* RpcClient.CurrentHeaders,
        Headers.fromInput(options?.headers ?? {}),
      );
      const sent: Call = {
        requestId: SecureRandom.uuidV4Unsafe(),
        tag,
        payload: yield* encode(payloadCodec(rpc), payload),
        headers: Object.fromEntries(Object.entries(headers)),
      };
      return sent;
    });
    /** Send `sent`, again on a fresh stub while a persisted call's failure is transient. */
    const send = <A>(
      method: (target: EntityObjectStub) => Effect.Effect<A, unknown>,
    ): Effect.Effect<A, PersistenceError> =>
      Effect.suspend(() => method(stub())).pipe(
        Effect.retry({
          while: (error) => persisted && isRetryable(error),
          schedule: Schedule.exponential("100 millis"),
          times: 3,
        }),
        Effect.mapError((cause) => PersistenceError.make({ cause })),
      );
    /** Interrupting the caller interrupts the handler. */
    const interruptible = <A, E>(sent: Call, effect: Effect.Effect<A, E>) =>
      Effect.onInterrupt(effect, () => Effect.ignore(stub().interrupt(sent.requestId)));
    const answer = (reply: Reply) =>
      Effect.gen(function* () {
        if (DEFECT in reply) return yield* Effect.die(new Error(reply[DEFECT]));
        if ("rejected" in reply) return yield* rejectionError(address, reply.rejected);
        const exit = (yield* decode(exitCodec(rpc), reply.exit)) as Exit.Exit<unknown, unknown>;
        return yield* exit;
      });
    methods[tag] = RpcSchema.isStreamSchema(rpc.successSchema)
      ? (payload: unknown, options?: { readonly headers?: Headers.Input }) =>
          Stream.unwrap(
            Effect.map(message(payload, options), (sent) =>
              stub()
                .stream(JSON.stringify(sent))
                .pipe(
                  Stream.mapError((cause) => PersistenceError.make({ cause })),
                  Stream.mapEffect((frame) =>
                    Effect.gen(function* () {
                      const parsed = JSON.parse(frame) as Frame;
                      if ("chunk" in parsed) {
                        return yield* Effect.forEach(parsed.chunk, (value) =>
                          decode(chunkCodec(rpc), value),
                        );
                      }
                      yield* answer(parsed);
                      return [];
                    }),
                  ),
                  Stream.flatMap((values) => Stream.fromIterable(values)),
                  Stream.onExit((exit) =>
                    Exit.hasInterrupts(exit)
                      ? Effect.ignore(stub().interrupt(sent.requestId))
                      : Effect.void,
                  ),
                ),
            ),
          )
      : (
          payload: unknown,
          options?: { readonly discard?: boolean; readonly headers?: Headers.Input },
        ) =>
          Effect.gen(function* () {
            const sent = yield* message(payload, options);
            const text = JSON.stringify(sent);
            if (options?.discard === true) {
              const reply = yield* send((target) => call<string>(target.tell(text)));
              const parsed = JSON.parse(reply) as Partial<Extract<Reply, { rejected: Rejection }>>;
              if (parsed.rejected !== undefined) {
                return yield* rejectionError(address, parsed.rejected);
              }
              return;
            }
            const reply = yield* interruptible(
              sent,
              send((target) => call<string>(target.ask(text))),
            );
            return yield* answer(JSON.parse(reply) as Reply);
          });
  }
  return methods;
};

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

/**
 * Every entity instance: one object per `(type, id)`, running the instance
 * as Effect Cluster's runners do (see `EntityRuntime.ts`).
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
      const entity = yield* makeEntityRuntime({
        hosted,
        address: EntityAddress.make({
          shardId: ShardId.make("cloudflare", 1),
          entityType: EntityType.make(type),
          entityId: EntityId.make(id),
        }),
        runnerAddress: RunnerAddress.make(objectName(state), 0),
        context: Context.merge(withSharding(hosted.context), runtime),
        storage: state.raw.storage as unknown as NativeStorage,
        waitUntil: (effect) => state.waitUntil(effect).pipe(Effect.provideContext(runtime)),
      });
      return {
        ask: (message: string) => reportDefects(entity.ask(JSON.parse(message) as Call)),
        tell: (message: string) => reportDefects(entity.tell(JSON.parse(message) as Call)),
        stream: (message: string) => entity.stream(JSON.parse(message) as Call),
        interrupt: (requestId: string) => entity.interrupt(requestId),
        alarm: () => entity.alarm,
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
