/**
 * Effect Cluster on durable objects, in Effect's shape: there are no shards
 * or runners to place an instance on, because a durable object (a Cloudflare
 * Durable Object, a Rivet actor) already is one instance per name. Every
 * entity instance is the object named by its `(type, id)`, every workflow
 * execution the object named by its `(workflow, execution)`, every singleton
 * and cron the object named after it.
 *
 * `Sharding` is the seam: Effect Cluster's own client (`Entity.client`), the
 * gateway and one entity calling another all ask it for a client, and this
 * one sends each call to the entity's object. A host supplies the objects:
 * their storage and alarm, and stubs to call them by name.
 *
 * @internal
 */
import { makeEntrypointLayer } from "alchemy/Runtime";
import { stackFromEnv } from "alchemy/Runtime/Bootstrap";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import type { ObjectImpl } from "alchemy/Workers/DurableObjectEngine";
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
import type * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { type Rpc, RpcClient, RpcSchema } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Workflow as EffectWorkflow, WorkflowEngine } from "effect/workflow";
import type { HostedCron } from "../Cron.ts";
import { type HostedEntity, PlatformDeclaration } from "../Entity.ts";
import { RunnerHost } from "../Host.ts";
import type { HostedSingleton } from "../Singleton.ts";
import type { HostedWorkflow } from "../Workflow.ts";
import { type EntityStorage, makeEntityRuntime } from "./EntityRuntime.ts";
import { HasNoPool, type HostedRuntimeContext } from "./HostedRuntime.ts";
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

type AnyEntity = EffectEntity.Entity<string, Rpc.Any>;

type Hosted = HostedEntity | HostedWorkflow | HostedSingleton | HostedCron;

/** A class this pool hosts was asked for, but nothing registered it. */
export class NotHosted extends Data.TaggedError("Cluster.NotHosted")<{
  readonly message: string;
}> {}

/**
 * What a pool's process registers, for its objects to run: each object reads
 * the class it runs from here when it is constructed.
 */
export const registry = {
  entities: new Map<string, HostedEntity>(),
  scheduled: new Map<string, HostedSingleton | HostedCron>(),
  workflows: new Map<string, ObjectImpl<unknown>>(),
  sharding: undefined as Sharding.Sharding["Service"] | undefined,
};

// ---------------------------------------------------------------- names

/** The object a workflow execution runs in: `${class}:${executionId}`. */
export const workflowObjectName = (className: string, executionId: string) =>
  `${className}:${executionId}`;

/** The workflow class an object named by {@link workflowObjectName} runs. */
export const workflowClassOf = (objectName: string) => objectName.slice(0, objectName.indexOf(":"));

/** The object a singleton or cron runs in: `singleton:${name}` or `cron:${name}`. */
export const scheduledObjectName = (kind: "singleton" | "cron", name: string) => `${kind}:${name}`;

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

/** Answer a defect as data, since an object's caller can't be sent a cause. */
export const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.succeed({ [DEFECT]: Cause.pretty(cause) } as unknown as A)),
  );

// ---------------------------------------------------------------- sharding

/** What an entity's object answers: calls and replies as JSON text. */
export interface EntityObjectStub {
  readonly ask: (call: string) => Effect.Effect<string, unknown>;
  readonly tell: (call: string) => Effect.Effect<string, unknown>;
  readonly stream: (call: string) => Stream.Stream<string, unknown>;
  readonly interrupt: (requestId: string) => Effect.Effect<void, unknown>;
}

/** What a singleton's or cron's object answers. */
export interface ScheduledObjectStub {
  readonly ensure: () => Effect.Effect<void, unknown>;
}

export interface Namespace<Stub> {
  readonly getByName: (name: string) => Stub;
}

/** What differs between the hosts whose objects back a cluster. */
export interface ObjectHost {
  /** The shard group every address on this host is in: the host's name. */
  readonly group: string;
  /**
   * Whether a failed call to an object can be sent again: the host knows a
   * transient failure from one the object answered with.
   */
  readonly isRetryable: (error: unknown) => boolean;
}

/** The address of an entity instance on `host`: its one shard is the host itself. */
const addressOf = (host: ObjectHost, type: string, id: string) =>
  EntityAddress.make({
    shardId: ShardId.make(host.group, 1),
    entityType: EntityType.make(type),
    entityId: EntityId.make(id),
  });

/** A rejection the object answered with, as Effect Cluster's error. */
const rejectionError = (address: EntityAddress.EntityAddress, rejection: Rejection) => {
  switch (rejection._tag) {
    case "MailboxFull":
      return MailboxFull.make({ address });
    case "AlreadyProcessingMessage":
      return AlreadyProcessingMessage.make({ address, envelopeId: Snowflake.Snowflake(0n) });
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
export const clientOf = (
  entity: AnyEntity,
  entityId: string,
  objects: () => Namespace<EntityObjectStub>,
  host: ObjectHost,
  /** Whether the pool hosts the entity: checked before any object is woken. */
  hosts: (type: string) => boolean = () => true,
) => {
  const address = addressOf(host, entity.type, entityId);
  const stub = () => objects().getByName(entityObjectName(entity.type, entityId));
  const hosted = Effect.suspend(() =>
    hosts(entity.type)
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
          while: (error) => persisted && host.isRetryable(error),
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

const unused = (operation: string) =>
  Effect.die(new NotHosted({ message: `Sharding.${operation} is not used on durable objects.` }));

/** `Sharding` for a process whose entities are durable objects. */
export const makeObjectSharding = (
  objects: () => Namespace<EntityObjectStub>,
  host: ObjectHost,
): Sharding.Sharding["Service"] =>
  ({
    getShardId: (_entityId: string, group: string) => ShardId.make(group, 1),
    hasShardId: () => true,
    getSnowflake: Effect.map(Clock.currentTimeMillis, (now) =>
      Snowflake.Snowflake(BigInt(now) << 22n),
    ),
    isShutdown: Effect.succeed(false),
    makeClient: (entity: AnyEntity) =>
      Effect.succeed((entityId: string) =>
        clientOf(entity, entityId, objects, host, (type) => registry.entities.has(type)),
      ),
    getRegistrationEvents: Stream.empty,
    registerEntity: () => unused("registerEntity"),
    registerSingleton: () => unused("registerSingleton"),
    send: () => unused("send"),
    sendOutgoing: () => unused("sendOutgoing"),
    notify: () => unused("notify"),
    reset: () => Effect.succeed(false),
    pollStorage: Effect.void,
    activeEntityCount: Effect.sync(() => registry.entities.size),
  }) as unknown as Sharding.Sharding["Service"];

/** The services everything hosted runs with, beyond its own: the cluster's `Sharding`. */
const withSharding = (context: Context.Context<never>) =>
  registry.sharding === undefined
    ? context
    : Context.add(context, Sharding.Sharding, registry.sharding);

// ---------------------------------------------------------------- entities

/**
 * One entity instance, in the object named `name`: the instance runs as
 * Effect Cluster's runners run it (see `EntityRuntime.ts`), and answers its
 * callers in JSON text.
 */
export const makeEntityObject = Effect.fn(function* (options: {
  readonly name: string;
  readonly host: ObjectHost;
  readonly storage: EntityStorage;
  /** The object's own services, which its handlers run with. */
  readonly runtime: Context.Context<RuntimeContext>;
  readonly maxEncodedBytes?: number;
  readonly waitUntil: (effect: Effect.Effect<unknown>) => Effect.Effect<void>;
}) {
  const { type, id } = parseEntityObjectName(options.name);
  const hosted = registry.entities.get(type);
  if (hosted === undefined) {
    return yield* Effect.die(
      new NotHosted({ message: `This pool hosts no Cluster.Entity '${type}'.` }),
    );
  }
  const entity = yield* makeEntityRuntime({
    hosted,
    address: addressOf(options.host, type, id),
    runnerAddress: RunnerAddress.make(options.name, 0),
    context: Context.merge(withSharding(hosted.context), options.runtime),
    storage: options.storage,
    maxEncodedBytes: options.maxEncodedBytes,
    waitUntil: options.waitUntil,
  });
  return {
    ask: (message: string) => reportDefects(entity.ask(JSON.parse(message) as Call)),
    tell: (message: string) => reportDefects(entity.tell(JSON.parse(message) as Call)),
    stream: (message: string) => entity.stream(JSON.parse(message) as Call),
    interrupt: (requestId: string) => entity.interrupt(requestId),
    alarm: () => entity.alarm,
  };
});

// ---------------------------------------------------------------- singletons and crons

/** How often a singleton's object checks that it is still running. */
const SINGLETON_HEARTBEAT = 10_000;

/**
 * One singleton or cron, in the object named `name`, kept awake by its
 * alarm. A singleton's object runs its fiber and checks on it every few
 * seconds, restarting it if its object was restarted; a cron's object wakes
 * at each scheduled time and runs the job once.
 */
export const makeScheduledObject = Effect.fn(function* (options: {
  readonly name: string;
  readonly storage: Pick<EntityStorage, "exec" | "setAlarm">;
  readonly runtime: Context.Context<RuntimeContext>;
}) {
  const { exec, setAlarm } = options.storage;
  const hosted = registry.scheduled.get(options.name.slice(options.name.indexOf(":") + 1));
  if (hosted === undefined) {
    return yield* Effect.die(
      new NotHosted({ message: `This pool hosts no singleton or cron '${options.name}'.` }),
    );
  }
  yield* exec(
    "CREATE TABLE IF NOT EXISTS cluster_schedule (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  const context = Context.merge(withSharding(hosted.context), options.runtime);

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
    exec<{ value: number }>("SELECT value FROM cluster_schedule WHERE key = 'next'"),
    ([row]) => row?.value,
  );
  const writeNext = (next: number) =>
    Effect.andThen(
      exec("INSERT OR REPLACE INTO cluster_schedule (key, value) VALUES ('next', ?)", next),
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
      skipAfter !== undefined && now - due > Duration.toMillis(Duration.fromInputUnsafe(skipAfter));
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
  // Its alarm is set again even when its next time is known: the alarm may
  // be what was lost.
  const ensure = Effect.gen(function* () {
    const due = yield* readNext;
    yield* due === undefined
      ? writeNext(nextAfter(yield* Clock.currentTimeMillis))
      : setAlarm(Math.max(due, yield* Clock.currentTimeMillis));
  });
  return { ensure: () => reportDefects(ensure), alarm: () => fire };
});

/** Wake every singleton and cron, so their objects start their alarms. */
export const wakeScheduled = (objects: Namespace<ScheduledObjectStub>) =>
  Effect.forEach(
    registry.scheduled.values(),
    (hosted) =>
      objects.getByName(scheduledObjectName(hosted.kind, hosted.name)).ensure().pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );

// ---------------------------------------------------------------- hosting

/** A class the pool hosts: its name, and its module's export. */
export interface HostedDefinition {
  readonly name: string;
  readonly value: unknown;
}

// oxlint-disable-next-line effecttsgo/service-not-as-class
const entrypointTag = Context.Service<any, any>(Self.key);

/**
 * Build each class's Construction phase, keeping what its runtime context
 * hosts. A Layer that hosts its entities itself (a Domain model's) provides
 * no class: it hands them to `RunnerHost`, with a Layer to launch beside
 * them once the workflow engine and Sharding are up.
 */
const buildHosted = (definitions: ReadonlyArray<HostedDefinition>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const hosted: Array<Hosted> = [];
    const launched: Array<Layer.Layer<never, never, any>> = [];
    const runner = RunnerHost.of({
      host: (entity, layer) =>
        Effect.sync(() => {
          if (!hosted.some((h) => h.kind === "entity" && h.entity.type === entity.entity.type))
            hosted.push(entity);
          launched.push(layer);
        }),
    });
    for (const { value } of definitions) {
      const declaration =
        (value as { [PlatformDeclaration]?: unknown } | undefined)?.[PlatformDeclaration] ?? value;
      const context = yield* Layer.buildWithScope(
        makeEntrypointLayer(entrypointTag, declaration),
        scope,
      ).pipe(Effect.provideService(RunnerHost, runner));
      const self = Context.getOption(context, entrypointTag);
      if (Option.isNone(self)) continue;
      const runtime = self.value.RuntimeContext as HostedRuntimeContext<Hosted>;
      const built = runtime.hosted();
      if (built === undefined) {
        return yield* Effect.die(
          new HasNoPool({
            message: `${runtime.Type} '${runtime.id}' did not finish its Construction phase.`,
          }),
        );
      }
      hosted.push(built);
    }
    return { hosted, launched };
  });

/**
 * Build every class a pool hosts and register it for the pool's objects:
 * entities, singletons and crons by name, and each workflow on `engine`,
 * whose executions are objects too. Runs once per process, in `scope`.
 */
export const hostClasses = Effect.fn(function* (options: {
  readonly definitions: ReadonlyArray<HostedDefinition>;
  readonly scope: Scope.Scope;
  readonly sharding: Sharding.Sharding["Service"];
  /** The workflow engine, which registers each workflow's class in {@link registry}. */
  readonly engine: Layer.Layer<WorkflowEngine.WorkflowEngine>;
}) {
  registry.sharding = options.sharding;
  const { hosted, launched } = yield* buildHosted(options.definitions, options.scope).pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, stackFromEnv)),
  );
  const entities = hosted.filter((entry): entry is HostedEntity => entry.kind === "entity");
  const workflows = hosted.filter((entry): entry is HostedWorkflow => entry.kind === "workflow");
  for (const entry of entities) registry.entities.set(entry.entity.type, entry);
  for (const entry of hosted) {
    if (entry.kind === "singleton" || entry.kind === "cron") {
      registry.scheduled.set(entry.name, entry);
    }
  }
  // Each handler runs with the services its Construction phase had, and the
  // cluster's Sharding.
  const sharding = Layer.succeed(Sharding.Sharding, options.sharding);
  const workflowLayers = workflows.map((entry) =>
    (entry.workflow as EffectWorkflow.Workflow<string, any, any, any>).toLayer(
      (payload, executionId) =>
        entry
          .execute(payload, executionId)
          .pipe(
            Effect.provideContext(Context.add(entry.context, Sharding.Sharding, options.sharding)),
          ) as Effect.Effect<any, any, never>,
    ),
  );
  const services = yield* Layer.buildWithScope(
    Layer.mergeAll(...(workflowLayers as [Layer.Layer<never>]), ...launched).pipe(
      Layer.provideMerge(options.engine),
      Layer.provideMerge(sharding),
    ),
    options.scope,
  );
  return { entities, workflows, services };
});
