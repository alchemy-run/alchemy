import {
  alarmCallbacks,
  className,
  type Host,
  type ListOptions,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  parseMultiplexedName,
} from "@alchemy.run/domain/DurableObjects";
import type { Platform } from "@alchemy.run/domain/Platform";
/**
 * Host a domain model (`@alchemy.run/domain`) on Effect Cluster entities.
 *
 * @module
 */
import { PgClient } from "@effect/sql-pg";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeInputGate, type InputGateShape } from "alchemy/Workers/InputGate";
import { decodeResult, encodeResult, payloadCodec } from "alchemy/WorkflowEncoding";
import { ClusterSchema, DeliverAt, Entity as EffectEntity } from "effect/cluster";
import * as Config from "effect/Config";
import type * as ConfigError from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PrimaryKey from "effect/PrimaryKey";
import * as Random from "effect/Random";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { SqlClient } from "effect/sql/SqlClient";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { EntityTypeId, type EntityNamespace, type InstanceServices } from "../Entity.ts";
import { addClusterLayer } from "../internal/ClusterLayers.ts";
import { makeNamespace } from "../internal/Gateway.ts";

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

const rpcs = [
  Rpc.make("Call", {
    // Arguments and results cross runners as JSON text, as fetch-RPC sends them.
    payload: { method: Schema.String, args: Schema.String },
    success: Schema.String,
  }),
  Rpc.make("Wake", { payload: Wake }).annotate(ClusterSchema.Persisted, true),
] as const;

type DomainRpcs = (typeof rpcs)[number];

/**
 * The entity a domain model runs on: every aggregate instance, view key,
 * policy and projection key is one entity id of it
 * (`Bank.AccountAggregate/a-1`). Declare the class with it.
 */
export const entity = <const Type extends string>(
  type: Type,
): EffectEntity.Entity<Type, DomainRpcs> => EffectEntity.make(type, rpcs);

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
    list: <T>({ prefix, start, startAfter, end, limit }: ListOptions = {}) =>
      run(
        sql<{ key: string; value: string }>`SELECT key, value FROM ${sql(TABLE)}
          WHERE object = ${object}
          ${prefix ? sql`AND starts_with(key, ${prefix})` : sql``}
          ${start !== undefined ? sql`AND key >= ${start}` : sql``}
          ${startAfter !== undefined ? sql`AND key > ${startAfter}` : sql``}
          ${end !== undefined ? sql`AND key < ${end}` : sql``}
          ORDER BY key
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
          get:
            (_, method) =>
            (...args: ReadonlyArray<unknown>) =>
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
  engine: () => WorkflowEngine.WorkflowEngine["Service"],
): InstanceBuild =>
  Effect.succeed({
    wfExecute: (executionId: string, payload: string, _discard: boolean) =>
      Effect.gen(function* () {
        const workflow = workflows.get(yield* workflowName) as Workflow.AnyWithProps;
        const decoded = yield* Schema.decodeEffect(payloadCodec(workflow))(
          JSON.parse(payload),
        ).pipe(Effect.orDie);
        yield* engine().execute(workflow as never, {
          executionId,
          payload: decoded as never,
          discard: true,
        });
        // The run starts; callers that wait poll it.
        const polled = yield* engine().poll(workflow as never, executionId);
        return Option.isSome(polled) && polled.value._tag === "Complete"
          ? yield* encodeResult(workflow, polled.value.exit as Exit.Exit<unknown, unknown>)
          : null;
      }),
    wfPoll: (executionId: string) =>
      Effect.gen(function* () {
        const workflow = workflows.get(yield* workflowName) as Workflow.AnyWithProps;
        const polled = yield* engine().poll(workflow as never, executionId);
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
      Effect.flatMap(workflowName, (name) => engine().interrupt(workflows.get(name)!, executionId)),
    wfInterruptUnsafe: (executionId: string) =>
      Effect.flatMap(workflowName, (name) =>
        engine().interruptUnsafe(workflows.get(name)!, executionId),
      ),
    wfResume: (executionId: string) =>
      Effect.flatMap(workflowName, (name) => engine().resume(workflows.get(name)!, executionId)),
    wfSignal: (executionId: string, deferredName: string, exit: string) =>
      Effect.gen(function* () {
        const deferred = encodedDeferred(deferredName);
        const decoded = yield* Schema.decodeEffect(
          deferred.exitSchema as unknown as Schema.Codec<unknown, unknown>,
        )(JSON.parse(exit)).pipe(Effect.orDie);
        yield* engine().deferredDone(deferred, {
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

/**
 * The Construction phase of a `Cluster.Entity` that hosts a domain model:
 * every aggregate instance, view key, policy and projection key of the model
 * is one entity id of it, named after it (`Bank.AccountAggregate/a-1`).
 * Declare the class with {@link entity}, pass the model's Layer, with the
 * services its policies and projections need, and provide a pool Layer as
 * usual.
 *
 * Commands to one aggregate instance run one at a time, through each
 * instance's input gate. Every instance's events, state and outbox live in
 * the cluster's Postgres, in one table, and commit together. Scheduled
 * commands and retries are persisted messages delivered when they are due.
 * The model's sagas run on Effect Cluster's workflow engine. Live reads are
 * streamed responses that poll the owning instance.
 *
 * Calls between the model's instances may come back to the instance that
 * made them, so give the class `concurrency: "unbounded"`: each instance's
 * input gate keeps its storage consistent.
 *
 * Callers reach the model through {@link layer}.
 *
 * ### Hosting a model on Effect Cluster
 * **Example:** The entity that runs the model on a pool
 * ```typescript
 * import * as Cluster from "@alchemy.run/effect-cluster";
 * import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
 * import * as DomainCluster from "@alchemy.run/effect-cluster/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const Database = ClusterDocker.Database("Cluster");
 * export const Default = ClusterDocker.SwarmPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 *
 * export default class BankObjects extends Cluster.Entity<BankObjects>()(
 *   DomainCluster.entity("Bank"),
 *   { main: import.meta.url, concurrency: "unbounded" },
 *   DomainCluster.host(Bank.layer(BankHandlers)).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * @primitive
 */
export const host = <ROut, E, RIn>(
  model: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<
  Effect.Effect<EffectEntity.HandlersFrom<DomainRpcs>, never, InstanceServices>,
  ConfigError.ConfigError,
  | Exclude<RIn, Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom>
  | RuntimeContext
> =>
  Effect.gen(function* () {
    const ctx = yield* RuntimeContext;
    if (ctx.Type !== EntityTypeId) {
      return yield* Effect.die(
        new Error("DomainCluster.host is the Construction phase of a Cluster.Entity."),
      );
    }
    // In this pool's shard group, as the runner registers its entities.
    const shardGroup = () =>
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
        .CLUSTER_SHARD_GROUPS ?? "default";
    const objects = entity(ctx.id).annotate(ClusterSchema.ShardGroup, shardGroup);
    // The sagas' runs too: a run is routed by its workflow's shard group.
    const placed = <W extends Workflow.Any>(workflow: W): W =>
      Object.create(workflow, {
        annotations: {
          value: Context.add(workflow.annotations, ClusterSchema.ShardGroup, shardGroup),
          enumerable: true,
        },
      });
    // Inside the cluster, calls route through Effect Cluster itself.
    const self = remote(
      makeNamespace(objects as never, { url: "", token: "", service: "" }) as never,
    );
    const classes = new Map<string, InstanceBuild>();
    const workflows = new Map<string, Workflow.Any>();
    const registrations: Array<
      readonly [Workflow.Any, (payload: any, id: string) => Effect.Effect<any, any, any>]
    > = [];
    // Set once the runner has joined the cluster.
    let engine: WorkflowEngine.WorkflowEngine["Service"] | undefined;
    const started = () => {
      if (engine === undefined)
        throw new DomainEngineNotStarted({
          message: "The cluster's workflow engine isn't running yet.",
        });
      return engine;
    };
    // Sagas register while the model's Layer builds, before the runner joins
    // the cluster: hold them until then, and run every call on its engine.
    const deferredEngine = WorkflowEngine.WorkflowEngine.of({
      register: ((
        workflow: Workflow.Any,
        execute: (payload: any, id: string) => Effect.Effect<any, any, any>,
      ) =>
        Effect.sync(() => {
          workflows.set(workflow._tag, placed(workflow));
          registrations.push([placed(workflow), execute]);
        })) as never,
      execute: ((workflow: any, options: any) =>
        Effect.suspend(() => started().execute(placed(workflow), options))) as never,
      poll: ((workflow: any, id: string) =>
        Effect.suspend(() => started().poll(placed(workflow), id))) as never,
      interrupt: (workflow, id) => Effect.suspend(() => started().interrupt(placed(workflow), id)),
      interruptUnsafe: (workflow, id) =>
        Effect.suspend(() => started().interruptUnsafe(placed(workflow), id)),
      resume: (workflow, id) => Effect.suspend(() => started().resume(placed(workflow), id)),
      activityExecute: ((activity: any, attempt: number) =>
        Effect.suspend(() => started().activityExecute(activity, attempt))) as never,
      deferredResult: ((deferred: any) =>
        Effect.suspend(() => started().deferredResult(deferred))) as never,
      deferredDone: ((deferred: any, options: any) =>
        Effect.suspend(() => started().deferredDone(deferred, options))) as never,
      scheduleClock: (workflow, options) =>
        Effect.suspend(() => started().scheduleClock(placed(workflow), options)),
    });
    classes.set(
      WORKFLOWS,
      workflowsObject(workflows, () => started()),
    );
    const objectHost: Host = {
      declare: ({ modelName }, cls, impl: ObjectImpl) =>
        Effect.sync(() => {
          classes.set(className(modelName, cls), impl);
          return self(className(modelName, cls));
        }),
      lookup: ({ modelName }, cls) => self(className(modelName, cls)),
      claimKey: Effect.succeed(claimOf(ctx.id)),
    };
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the platform, engine and SecureRandom are provided here; the rest are the caller's
      model.pipe(
        Layer.provide(
          Layer.merge(
            makePlatform(objectHost),
            Layer.succeed(WorkflowEngine.WorkflowEngine, deferredEngine),
          ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto)),
        ),
      ) as Layer.Layer<ROut, E, never>,
      scope,
    ).pipe(Effect.orDie);

    if (globalThis.__ALCHEMY_RUNTIME__) {
      // Once the runner has joined the cluster: register the sagas with its engine.
      addClusterLayer(
        Effect.gen(function* () {
          const clusterEngine = yield* WorkflowEngine.WorkflowEngine;
          for (const [workflow, execute] of registrations)
            yield* clusterEngine.register(workflow as never, execute as never);
          engine = clusterEngine;
        }).pipe(Layer.effectDiscard),
      );
    }

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

    return Effect.gen(function* () {
      const address = yield* EffectEntity.CurrentAddress;
      const name = address.entityId;
      const parsed = name.startsWith(`${WORKFLOWS}/`)
        ? { className: WORKFLOWS, key: name.slice(WORKFLOWS.length + 1) }
        : parseMultiplexedName(name);
      const build = parsed === undefined ? undefined : classes.get(parsed.className);
      if (build === undefined) {
        return yield* Effect.die(
          new DomainClassNotHosted({
            message: `Cluster.Entity '${ctx.id}' hosts no Domain class for '${name}'.`,
          }),
        );
      }
      const client = yield* sql;
      const gate = yield* makeInputGate;
      const storage = objectStorage(client, `${ctx.id}/${name}`, gate);
      const instanceScope = yield* Scope.Scope;
      const wakes = yield* objects.client;
      const callbacks = alarmCallbacks(storage, {
        set: (at) =>
          Effect.gen(function* () {
            yield* storage.put("~alarm", at);
            yield* wakes(name)
              .Wake(Wake.make({ at, id: String(yield* Random.nextInt) }), { discard: true })
              .pipe(Effect.orDie);
          }),
        get: storage.get<number>("~alarm").pipe(Effect.map((at) => at ?? null)),
      });
      const state: ObjectStateShape = {
        storage,
        exclusive: (effect) => gate.exclusive(effect),
        // Background work stays part of the call that started it.
        waitUntil: (effect) => Effect.asVoid(Effect.forkIn(effect, instanceScope)),
      };
      const runtime = yield* RuntimeContext;
      const record = yield* build.pipe(
        Effect.provideService(ObjectState, state),
        Effect.provideService(RuntimeContext, { ...runtime, makeCallback: callbacks.makeCallback }),
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
                : Effect.die(new Error(`${name} has no method ${payload.method}`));
            }).pipe(Effect.map((result) => JSON.stringify(result ?? null))),
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
    }) as never;
  }) as never;

/**
 * The Domain platform for code that calls a model hosted by {@link host}:
 * a Worker, a Lambda, a container, another entity. Provide it to the
 * model's Layer, as `Domain.InMemory` would be. Commands, reads and saga
 * runs reach the model's entities through the pool's gateway, or through
 * Effect Cluster itself inside the cluster.
 *
 * ### Calling a model on Effect Cluster
 * **Example:** A container serving an Api over the cluster-hosted model
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as DomainCluster from "@alchemy.run/effect-cluster/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 * import BankObjects from "./BankObjects.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const BankLive = Bank.layer(BankHandlers).pipe(Layer.provide(DomainCluster.layer(BankObjects)));
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
export const layer = <R>(
  objects: Effect.Effect<EntityNamespace<DomainRpcs>, never, R>,
): Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom, never, R> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const namespace = yield* objects;
      const self = remote(namespace);
      // Callers of one host entity share a claim key: the entity's type is unknown here.
      const host: Host = {
        declare: ({ modelName }, cls) => Effect.succeed(self(className(modelName, cls))),
        lookup: ({ modelName }, cls) => self(className(modelName, cls)),
        claimKey: Effect.succeed(namespace),
      };
      return Layer.merge(
        makePlatform(host),
        Layer.succeed(WorkflowEngine.WorkflowEngine, remoteEngine(self(WORKFLOWS))),
      ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
    }),
  ) as Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom, never, R>;
