/**
 * Host a domain model (`@alchemy.run/domain`) on Effect Cluster entities.
 *
 * @module
 */
import {
  Entity,
  type EntityNamespace,
  type EntityRuntimeContext,
  PlatformDeclaration,
} from "@alchemy.run/effect-cluster/Entity";
import { HasNoPool, makeNamespace, RunnerHost } from "@alchemy.run/effect-cluster/Host";
import type { PoolLayer } from "@alchemy.run/effect-cluster/Pool";
import type { Providers } from "@alchemy.run/effect-cluster/Providers";
import { PgClient } from "@effect/sql-pg";
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { decodeResult, payloadCodec } from "alchemy/WorkflowEncoding";
import { ClusterSchema } from "effect/cluster";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { SqlClient } from "effect/sql/SqlClient";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import {
  className,
  type Host,
  makePlatform,
  type Namespace,
  type ObjectImpl,
} from "../DurableObjects.ts";
import type { Platform } from "../Platform.ts";
import {
  type CallEntity,
  claimOf,
  type DomainRpcs,
  DomainEngineNotStarted,
  entity,
  type InstanceBuild,
  makeInstance,
  migrate,
  remote,
  WORKFLOWS,
  workflowsObject,
} from "./host.ts";

export { DomainClassNotHosted, DomainEngineNotStarted } from "./host.ts";
export { layerMigrations, layerSharding, type ShardingOptions } from "./Sharding.ts";

/** Calls through an entity's namespace: Effect Cluster's own routing, or the pool's gateway. */
const namespaceCall =
  (namespace: EntityNamespace<DomainRpcs>): CallEntity =>
  (entityId, method, args) =>
    Effect.flatMap(namespace.getByName(entityId), (client) => client.Call({ method, args }));

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
 * The model's sagas run on Effect Cluster's workflow engine. Live reads are
 * streamed responses that poll the owning instance.
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
          const url = yield* Config.Redacted("CLUSTER_DATABASE_URL");
          const context = yield* Layer.buildWithScope(PgClient.layer({ url }), scope);
          const client = Context.get(context, SqlClient);
          yield* migrate(client);
          return client;
        }).pipe(Effect.orDie),
      );
      // Completed once the runner has joined the cluster; a call made
      // before then waits for it.
      const engine = yield* Deferred.make<WorkflowEngine.WorkflowEngine["Service"]>();
      const started = Deferred.await(engine);
      classes.set(WORKFLOWS, workflowsObject(workflows, started));

      // Each instance builds the object its entity id says.
      const instance = makeInstance({
        name,
        objects,
        sql,
        classOf: (cls) => Effect.succeed(classes.get(cls)),
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
          namespaceCall(
            makeNamespace(objects as never, { url: "", token: "", service: "" }) as never,
          ),
        );
        const host: Host = {
          declare: ({ modelName }, cls, impl: ObjectImpl) =>
            Effect.sync(() => {
              classes.set(className(modelName, cls), impl);
              return self(className(modelName, cls));
            }),
          lookup: ({ modelName }, cls) => self(className(modelName, cls)),
          claimKey: Effect.succeed(claimOf(name)),
        };
        return Layer.merge(
          makePlatform(host),
          Layer.succeed(WorkflowEngine.WorkflowEngine, deferredEngine),
        ).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
      }

      // A caller: deploy the entity, and reach it through the gateway.
      const self = remote(namespaceCall((yield* Objects) as EntityNamespace<DomainRpcs>));
      const host: Host = {
        declare: ({ modelName }, cls) => Effect.succeed(self(className(modelName, cls))),
        lookup: ({ modelName }, cls) => self(className(modelName, cls)),
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
