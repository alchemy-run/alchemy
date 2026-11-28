import {
  ClusterObjects,
  CONNECT_METHOD,
  layerObjectHost,
  LIVE_METHOD,
  type LiveFrame,
  ObjectClassNotHosted,
} from "@alchemy.run/effect-cluster/ObjectHost";
import type { PoolLayer } from "@alchemy.run/effect-cluster/Pool";
import type { Providers } from "@alchemy.run/effect-cluster/Providers";
/**
 * Host a domain model (`@alchemy.run/domain`) on Effect Cluster entities.
 *
 * @module
 */
import type { HttpEffect } from "alchemy/Http";
import { ObjectHost } from "alchemy/Workers/ObjectHost";
import {
  CurrentActivity,
  decodeResult,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import { ClusterSchema, Entity as EffectEntity, Sharding } from "effect/cluster";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { type Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import {
  type Attachment,
  className,
  type Host,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  runtimeClaim,
  SUBSCRIPTION_HEADER,
} from "../DurableObjects.ts";
import type { Platform, Subscription } from "../Platform.ts";
import { type Retention, sweep } from "./internal.ts";

export type { Retention } from "./internal.ts";

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
      readonly [CONNECT_METHOD]: (
        request: Request,
        attachment: string,
      ) => Effect.Effect<Response | undefined, unknown>;
    };
    const attachment = JSON.stringify({ key, subscription } satisfies Attachment);
    // Where the instance has an object of its own (a Durable Object), the
    // object holds the socket, hibernating in between commits.
    const upgrade = new Request(new URL(request.url, "http://instance/"), {
      headers: request.headers as Record<string, string>,
    });
    const forwarded = yield* stub[CONNECT_METHOD](upgrade, attachment).pipe(
      Effect.filterOrFail(
        (response) => response === undefined || response.status === 101,
        (response) => new Error(`Live read upgrade answered ${response?.status}`),
      ),
      // An object still running the previous deploy's code cannot upgrade.
      Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 5 }),
    );
    if (forwarded !== undefined) {
      const webSocket = (forwarded as unknown as { readonly webSocket: unknown }).webSocket;
      return HttpServerResponse.raw(
        new Response(null, { status: 101, webSocket } as ResponseInit),
        {
          status: 101,
        },
      );
    }
    const frames = stub[LIVE_METHOD](attachment);
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

/** Built for one entity id: an object's methods. */
type InstanceBuild = ObjectImpl;

/** A Domain host entity was asked for an object of a class it doesn't host. */
export { ObjectClassNotHosted as DomainClassNotHosted };

/** A saga's workflow engine was used before the runner joined the cluster. */
export class DomainEngineNotStarted extends Data.TaggedError("Cluster.DomainEngineNotStarted")<{
  readonly message: string;
}> {}

/** The object of every saga's runs, reached from outside the cluster. */
const WORKFLOWS = "~workflows";

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

/**
 * Effect Cluster's engine, as a model's sagas register on it. Each step of a
 * run gets its own sequence of command ids (`CurrentActivity`), as on the
 * other hosts: a step that runs again, after a retry or when its runner died,
 * sends the same commands, and they commit once. Effect Cluster runs a step
 * with the context it was called with, so the step sees it.
 *
 * @internal
 */
export const sagaEngine = (
  engine: WorkflowEngine.WorkflowEngine["Service"],
): WorkflowEngine.WorkflowEngine["Service"] => {
  const steps = WorkflowEngine.WorkflowEngine.of({
    ...engine,
    activityExecute: ((activity: Activity.Any, attempt: number) =>
      Effect.flatMap(WorkflowEngine.WorkflowInstance, (instance) =>
        engine
          .activityExecute(activity as never, attempt)
          .pipe(
            Effect.provideService(
              CurrentActivity,
              makeCurrentActivity(instance.workflow._tag, instance.executionId, activity.name),
            ),
          ),
      )) as never,
  });
  return WorkflowEngine.WorkflowEngine.of({
    ...engine,
    register: ((
      workflow: Workflow.Any,
      execute: (payload: any, id: string) => Effect.Effect<any, any, any>,
    ) =>
      engine.register(
        workflow as never,
        ((payload: unknown, id: string) =>
          execute(payload, id).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, steps),
          )) as never,
      )) as never,
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
  /**
   * How long the host keeps rows that only dedupe needs: command receipts,
   * policy delivery marks, cancelled scheduled commands, and Effect
   * Cluster's processed messages to the entity. On a pool with a cluster
   * database, every runner sweeps them each `interval`. On
   * `ClusterCloudflare.DurableObjectPool`, each instance keeps its rows in
   * its own storage and deletes a few past their window each time it
   * commits; `messages` and `interval` don't apply there.
   *
   * @default { receipts: "30 days", deliveries: "7 days", cancelled: "7 days", messages: "7 days", interval: "1 hour" }
   */
  readonly retention?: Retention;
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
 * streamed call through the pool's gateway. On
 * `ClusterCloudflare.DurableObjectPool`, called from a Worker, the
 * instance's Durable Object holds the WebSocket instead, and hibernates
 * between commits. Over `Domain.protocolHttp`, live reads are streamed
 * responses that poll the owning instance.
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
  Layer.unwrap(
    Effect.gen(function* () {
      const name = options.name;
      const objects = yield* ObjectHost;
      const cluster = yield* ClusterObjects;
      const lookup = (cls: string): Namespace => objects.lookup!(cls)!;
      // The sagas' runs too: a run is routed by its workflow's shard group.
      const placed = <W extends Workflow.Any>(workflow: W): W =>
        Object.create(workflow, {
          annotations: {
            value: Context.add(workflow.annotations, ClusterSchema.ShardGroup, cluster.shardGroup),
            enumerable: true,
          },
        });
      const host: Host = {
        declare: ({ modelName }, cls, impl: ObjectImpl) =>
          objects.declare(className(modelName, cls), impl),
        lookup: ({ modelName }, cls) => lookup(className(modelName, cls)),
        connect: connectTo,
        claimKey: runtimeClaim(name),
      };
      const runner = cluster.runner;
      if (runner !== undefined) {
        const workflows = new Map<string, Workflow.Any>();
        // A call made before the runner has joined the cluster waits for it.
        const started = Effect.map(runner.joined, ({ engine }) => engine);
        yield* objects.declare(WORKFLOWS, workflowsObject(workflows, started));
        // The runner's scope: the runs it begins live as long as it does.
        const scope = yield* Effect.scope;
        const registrations = yield* Ref.make<
          ReadonlyArray<
            readonly [Workflow.Any, (payload: any, id: string) => Effect.Effect<any, any, any>]
          >
        >([]);
        // Sagas register while the model's Layer builds, before the runner
        // joins the cluster: hold them until then, then run every call on its engine.
        yield* runner.onJoin(
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a saga's registration is untyped; it needs the engine it is given
          Effect.gen(function* () {
            const sagas = sagaEngine(yield* WorkflowEngine.WorkflowEngine);
            for (const [workflow, execute] of yield* Ref.get(registrations))
              yield* sagas.register(workflow as never, execute as never);
            // A pool with a cluster database keeps every instance's rows in
            // it, and its runners sweep them there. The Durable Object pool
            // has none: each instance prunes its own storage.
            if (Option.isSome(runner.database)) {
              // Each runner sweeps on its own; a sweep that fails runs at the next interval.
              yield* Effect.forkScoped(
                Effect.flatMap(runner.database.value, (client) =>
                  sweep(client, name, options.retention),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(`Cluster.Entity '${name}': retention sweep failed`, cause),
                  ),
                  Effect.repeat(
                    Schedule.spaced(
                      Duration.fromInputUnsafe(options.retention?.interval ?? "1 hour"),
                    ),
                  ),
                ),
              );
            }
          }).pipe(Effect.orDie) as Effect.Effect<
            void,
            never,
            WorkflowEngine.WorkflowEngine | Scope.Scope
          >,
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
        return Layer.merge(
          makePlatform(
            {
              ...host,
              // A deploy's new runs begin once the runner has joined, not on the
              // first call a caller makes: a model that nothing calls still catches up.
              begin: (runs) =>
                runner.joined.pipe(
                  Effect.flatMap(({ sharding }) =>
                    runs.pipe(
                      Effect.provideService(Sharding.Sharding, sharding),
                      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
                    ),
                  ),
                  // Still pending: the next call begins them.
                  Effect.ignore,
                  Effect.forkIn(scope),
                  Effect.asVoid,
                ),
            },
            { retention: Option.isSome(runner.database) ? false : (options.retention ?? {}) },
          ),
          Layer.succeed(WorkflowEngine.WorkflowEngine, deferredEngine),
        ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
      }

      // A caller: the entity is deployed, and reached through the gateway.
      return Layer.merge(
        makePlatform(host),
        Layer.succeed(WorkflowEngine.WorkflowEngine, remoteEngine(lookup(WORKFLOWS))),
      ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
    }),
  ).pipe(
    Layer.provide(
      layerObjectHost(options.name, { ...options, attachmentHeader: SUBSCRIPTION_HEADER }),
    ),
  ) as Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
    never,
    PoolReq | Providers
  >;
