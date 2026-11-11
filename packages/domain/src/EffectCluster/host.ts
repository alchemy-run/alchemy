/**
 * What every way of hosting a domain model on Effect Cluster entities
 * shares: the entity, each instance's storage, and the instance an entity
 * id builds.
 *
 * @internal
 */
import { RuntimeContext, type BaseRuntimeContext } from "alchemy/RuntimeContext";
import { makeInputGate, type InputGateShape } from "alchemy/Workers/InputGate";
import { encodeResult, payloadCodec } from "alchemy/WorkflowEncoding";
import { ClusterSchema, DeliverAt, Entity as EffectEntity } from "effect/cluster";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PrimaryKey from "effect/PrimaryKey";
import * as Random from "effect/Random";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { DurableDeferred, type Workflow, type WorkflowEngine } from "effect/workflow";
import {
  alarmCallbacks,
  type ListOptions,
  type Namespace,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  parseMultiplexedName,
} from "../DurableObjects.ts";

/**
 * Wake an instance at `at`: a persisted message delivered when it is due,
 * so it survives restarts and moves with the instance.
 */
export class Wake extends Schema.Class<Wake>("alchemy/Domain/Cluster/Wake")({
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

export type DomainRpcs = (typeof rpcs)[number];

/**
 * The entity a domain model runs on: every aggregate instance, view key,
 * policy and projection key is one entity id of it
 * (`Bank.AccountAggregate/a-1`).
 */
export const entity = <const Type extends string>(
  type: Type,
): EffectEntity.Entity<Type, DomainRpcs> => EffectEntity.make(type, rpcs);

/** Built for one entity id: an object's methods. */
export type InstanceBuild = Effect.Effect<
  Record<string, unknown>,
  never,
  ObjectState | RuntimeContext | Scope.Scope
>;

/** Where every instance keeps its storage: one row per key, in the cluster's database. */
export const TABLE = "alchemy_domain_objects";

const encode = (value: unknown) => JSON.stringify(value ?? null);
const decode = <T>(text: string) => JSON.parse(text) as T;

/**
 * Domain's storage for one entity id over the cluster's Postgres. Every
 * operation goes through the instance's input gate, as on Cloudflare.
 */
export const objectStorage = (
  sql: SqlClient,
  object: string,
  gate: InputGateShape,
): ObjectStorage => {
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

/** Create the storage table when it is missing. */
export const migrate = (sql: SqlClient): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
    object TEXT COLLATE "C" NOT NULL,
    key TEXT COLLATE "C" NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (object, key)
  )`);

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
export const claimOf = (type: string) => {
  let claim = claims.get(type);
  if (claim === undefined) claims.set(type, (claim = {}));
  return claim;
};

/** The object of every saga's runs, reached from outside the cluster. */
export const WORKFLOWS = "~workflows";

/** Calls to one entity id of the model's entity, as Domain's stubs. */
export type CallEntity = (
  entityId: string,
  method: string,
  args: string,
) => Effect.Effect<string, unknown>;

/** Domain's namespaces over {@link CallEntity}: one per class of objects. */
export const remote =
  (call: CallEntity) =>
  (cls: string): Namespace => ({
    getByName: (key: string) =>
      new Proxy(
        {},
        {
          get:
            (_, method) =>
            (...args: ReadonlyArray<unknown>) =>
              call(`${cls}/${key}`, String(method), JSON.stringify(args)).pipe(
                Effect.map((result) => JSON.parse(result) as unknown),
              ),
        },
      ) as never,
  });

/** A deferred left to Effect Cluster's engine to encode: its value arrives already encoded. */
const encodedDeferred = (name: string) =>
  DurableDeferred.make(name, { success: Schema.Unknown, error: Schema.Unknown });

/** The workflow a `~workflows/<name>` object serves: its key. */
const workflowName = Effect.map(EffectEntity.CurrentAddress, (address) =>
  address.entityId.slice(WORKFLOWS.length + 1),
);

/**
 * The `~workflows/<name>` object: what a caller outside the cluster asks of
 * the cluster's engine, by workflow name.
 */
export const workflowsObject = (
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

/** What runs one instance of a model's entity. */
export interface InstanceOptions {
  /** The entity's type. */
  readonly name: string;
  readonly objects: EffectEntity.Entity<string, DomainRpcs>;
  /** The database every instance keeps its storage in. */
  readonly sql: Effect.Effect<SqlClient>;
  /** The class an entity id names, once the model's Layer has declared it. */
  readonly classOf: (className: string) => Effect.Effect<InstanceBuild | undefined>;
}

/** Outside an Alchemy runtime (a plain process), the instance's own runtime context. */
const runtimeOf = (name: string): Effect.Effect<BaseRuntimeContext> =>
  Effect.map(Effect.serviceOption(RuntimeContext), (runtime) =>
    Option.getOrElse(runtime, () => ({
      Type: "Domain.EffectCluster",
      id: name,
      env: {},
      get: () => Effect.succeed(undefined),
      set: () => Effect.die(new Error(`Cluster.Entity '${name}' runs outside an Alchemy runtime.`)),
    })),
  );

/**
 * One instance of the model's entity: the object its entity id names, with
 * its storage, its input gate and its alarm.
 */
export const makeInstance = ({ name, objects, sql, classOf }: InstanceOptions) =>
  Effect.gen(function* () {
    const address = yield* EffectEntity.CurrentAddress;
    const id = address.entityId;
    const parsed = id.startsWith(`${WORKFLOWS}/`)
      ? { className: WORKFLOWS, key: id.slice(WORKFLOWS.length + 1) }
      : parseMultiplexedName(id);
    const build = parsed === undefined ? undefined : yield* classOf(parsed.className);
    if (build === undefined) {
      return yield* Effect.die(
        new DomainClassNotHosted({
          message: `Cluster.Entity '${name}' hosts no Domain class for '${id}'.`,
        }),
      );
    }
    const client = yield* sql;
    const gate = yield* makeInputGate;
    const storage = objectStorage(client, `${name}/${id}`, gate);
    const instanceScope = yield* Scope.Scope;
    const wakes = yield* objects.client;
    const callbacks = alarmCallbacks(storage, {
      set: (at) =>
        Effect.gen(function* () {
          yield* storage.put("~alarm", at);
          yield* wakes(id)
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
    const runtime = yield* runtimeOf(name);
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
