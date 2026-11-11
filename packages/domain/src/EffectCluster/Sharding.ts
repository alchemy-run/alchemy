/**
 * Host a domain model on the Effect Cluster `Sharding` of the current
 * process: no pool, gateway or Bootstrap resource.
 *
 * @module
 */
import { ClusterSchema, Sharding } from "effect/cluster";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { type Workflow, WorkflowEngine } from "effect/workflow";
import { className, type Host, makePlatform } from "../DurableObjects.ts";
import type { Platform } from "../Platform.ts";
import { claimOf, entity, type InstanceBuild, makeInstance, migrate, remote } from "./host.ts";

/** Options for {@link layerSharding}. */
export interface ShardingOptions {
  /** The entity that hosts the model: its type in the cluster. */
  readonly name: string;
  /**
   * The shard group the entity and the model's sagas are placed in.
   * @default the entity's default group
   */
  readonly shardGroup?: string;
  /**
   * How long a message to an instance waits for the model's Layer to declare
   * the instance's class. A runner can take messages (a timer due while it
   * was down) before the model's Layer has finished building.
   * @default "30 seconds"
   */
  readonly classWait?: Duration.Input;
}

/** The classes an entity hosts, for one `Sharding`: Layers that host on the same entity share it. */
interface Registry {
  readonly classes: Map<string, InstanceBuild>;
  readonly waiting: Map<string, Deferred.Deferred<InstanceBuild>>;
}

const registries = new WeakMap<object, Map<string, Registry>>();

/** The registry of `name` on `sharding`, and whether this call made it. */
const registryOf = (sharding: object, name: string) => {
  let byName = registries.get(sharding);
  if (byName === undefined) registries.set(sharding, (byName = new Map()));
  const existing = byName.get(name);
  if (existing !== undefined) return { registry: existing, fresh: false };
  const registry: Registry = { classes: new Map(), waiting: new Map() };
  byName.set(name, registry);
  return { registry, fresh: true };
};

/** Wake an instance waiting for `cls`, once the model declares it. */
const waitingFor = (registry: Registry, cls: string) => {
  let waiting = registry.waiting.get(cls);
  if (waiting === undefined) {
    waiting = Deferred.makeUnsafe<InstanceBuild>();
    registry.waiting.set(cls, waiting);
  }
  return waiting;
};

/**
 * Host a domain model on the Effect Cluster `Sharding` of the current
 * process. Provide it to the model's Layer, as `Domain.InMemory` or
 * {@link layerEntities} would be, and provide the cluster beside it: a
 * `Sharding` (from `NodeClusterHttp.layer`, `SingleRunner.layer`, …), the
 * `SqlClient` its storage uses, and its `ClusterWorkflowEngine`.
 *
 * The model's aggregate instances, view keys, policies and projection keys
 * are entity ids of one entity, `name`, registered on that `Sharding`. The
 * model's sagas run on the `WorkflowEngine` of the same context. Every
 * process that provides this Layer is a runner of the entity; a process on
 * a client-only `Sharding` only calls it.
 *
 * This Layer makes no table. Make the storage table with
 * {@link layerMigrations}, for example in a deploy step before the runners
 * start.
 *
 * ### Hosting a model in your own process
 * **Example:** A model on a Node runner
 * ```typescript
 * import { NodeClusterHttp } from "@effect/platform-node";
 * import { PgClient } from "@effect/sql-pg";
 * import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
 * import { ClusterWorkflowEngine } from "effect/cluster";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * const Sql = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });
 * const Cluster = ClusterWorkflowEngine.layer.pipe(
 *   Layer.provideMerge(NodeClusterHttp.layer({ transport: "http", storage: "sql" })),
 *   Layer.provideMerge(Sql),
 * );
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(DomainCluster.layerSharding({ name: "Bank" })),
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layerSharding = (
  options: ShardingOptions,
): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
  never,
  Sharding.Sharding | SqlClient | WorkflowEngine.WorkflowEngine
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { name, shardGroup } = options;
      const classWait = Duration.fromInputUnsafe(options.classWait ?? "30 seconds");
      const sharding = yield* Sharding.Sharding;
      const sql = yield* SqlClient;
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const objects =
        shardGroup === undefined
          ? entity(name)
          : entity(name).annotate(ClusterSchema.ShardGroup, () => shardGroup);
      const { registry, fresh } = registryOf(sharding, name);

      if (fresh) {
        yield* Effect.addFinalizer(() => Effect.sync(() => registries.get(sharding)?.delete(name)));
        // The model's Layer declares its classes after this Layer is built:
        // an instance whose class isn't declared yet waits for it.
        const classOf = (cls: string) =>
          Effect.suspend(() => {
            const found = registry.classes.get(cls);
            return found !== undefined
              ? Effect.succeed(found)
              : Deferred.await(waitingFor(registry, cls)).pipe(
                  Effect.timeoutOption(classWait),
                  Effect.map(Option.getOrUndefined),
                );
          });
        yield* sharding.registerEntity(
          objects,
          makeInstance({ name, objects, sql: Effect.succeed(sql), classOf }).pipe(
            Effect.provideService(Sharding.Sharding, sharding),
          ),
          // The model's objects call each other, and a call can come back to
          // the instance that made it; each instance's input gate keeps its
          // storage consistent.
          { concurrency: "unbounded" },
        );
      }

      const client = yield* Effect.provideService(objects.client, Sharding.Sharding, sharding);
      const self = remote((entityId, method, args) => client(entityId).Call({ method, args }));
      const host: Host = {
        declare: ({ modelName }, cls, impl) =>
          Effect.gen(function* () {
            const full = className(modelName, cls);
            registry.classes.set(full, impl);
            const waiting = registry.waiting.get(full);
            if (waiting !== undefined) {
              registry.waiting.delete(full);
              yield* Deferred.succeed(waiting, impl);
            }
            return self(full);
          }),
        lookup: ({ modelName }, cls) => self(className(modelName, cls)),
        claimKey: Effect.succeed(claimOf(name)),
      };
      return Layer.merge(
        makePlatform(host),
        Layer.succeed(
          WorkflowEngine.WorkflowEngine,
          shardGroup === undefined ? engine : placeWorkflows(engine, shardGroup),
        ),
      ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
    }),
  );

/** The engine, with every saga's runs routed to `shardGroup`. */
const placeWorkflows = (
  engine: WorkflowEngine.WorkflowEngine["Service"],
  shardGroup: string,
): WorkflowEngine.WorkflowEngine["Service"] => {
  const placed = <W extends Workflow.Any>(workflow: W): W =>
    Object.create(workflow, {
      annotations: {
        value: Context.add(workflow.annotations, ClusterSchema.ShardGroup, () => shardGroup),
        enumerable: true,
      },
    });
  return WorkflowEngine.WorkflowEngine.of({
    ...engine,
    register: (workflow, execute) => engine.register(placed(workflow), execute),
    execute: (workflow, options) => engine.execute(placed(workflow), options),
    poll: (workflow, id) => engine.poll(placed(workflow), id),
    interrupt: (workflow, id) => engine.interrupt(placed(workflow), id),
    interruptUnsafe: (workflow, id) => engine.interruptUnsafe(placed(workflow), id),
    resume: (workflow, id) => engine.resume(placed(workflow), id),
    scheduleClock: (workflow, opts) => engine.scheduleClock(placed(workflow), opts),
  });
};

/**
 * Make the table every instance of a model hosted by {@link layerSharding}
 * keeps its storage in, when it is missing. Run it once per database, for
 * example in a deploy step, with a role that may create tables.
 *
 * @layer
 */
export const layerMigrations: Layer.Layer<never, SqlError, SqlClient> = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migrate(yield* SqlClient);
  }),
);
