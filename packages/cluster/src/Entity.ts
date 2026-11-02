import * as nodePath from "node:path";
import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import * as Output from "alchemy/Output";
import {
  Platform,
  type PlatformIdentity,
  type PlatformProps,
  type PlatformServices,
} from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import { ClusterSchema, Entity as EffectEntity } from "effect/cluster";
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  PersistenceError,
} from "effect/cluster/ClusterError";
import type * as ConfigError from "effect/Config";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Rpc, RpcClient, RpcClientError, RpcGroup } from "effect/rpc";
import type { Scope } from "effect/Scope";
import { makeGatewayClient } from "./internal/Gateway.ts";
import { RunnersHost } from "./internal/RunnersHostService.ts";
import type { Providers } from "./Providers.ts";

export const EntityTypeId = "Cluster.Entity";
export type EntityTypeId = typeof EntityTypeId;

export interface EntityProps extends PlatformProps {
  /** The module that exports this entity's class, usually `import.meta.url`. */
  main: string;
  /**
   * The export of {@link main} that holds the class: the class, or the
   * Layer its `.make(...)` returned.
   * @default "default"
   */
  handler?: string;
  /**
   * How long an instance may sit idle before the runner stops it. Its next
   * message starts it again.
   * @default the runner's default (1 minute)
   */
  maxIdleTime?: Duration.Input;
  /**
   * How many of an instance's messages run at once.
   * @default 1
   */
  concurrency?: number | "unbounded";
}

export interface EntityAttributes {
  /** The entity type: the class's logical id. */
  type: string;
  /** The shard group of the runners that host it. */
  runners: string | undefined;
  /** The gateway URL callers send requests to. */
  gateway: string | undefined;
  /** The token callers present to the gateway. */
  token: Redacted.Redacted<string> | undefined;
}

/** Data a runners Layer binds onto the entities it hosts. */
export interface EntityBindingContract {
  runners?: string;
  gateway?: string;
  token?: Redacted.Redacted<string>;
}

export interface Entity extends Resource<
  EntityTypeId,
  EntityProps,
  EntityAttributes,
  EntityBindingContract,
  Providers
> {}

/** The errors a call through the gateway can fail with, beyond the RPC's own. */
export type GatewayError =
  | RpcClientError.RpcClientError
  | MailboxFull
  | AlreadyProcessingMessage
  | PersistenceError
  | EntityNotAssignedToRunner;

/** Every instance of one entity type, addressed by entity id. */
export type EntityClient<Rpcs extends Rpc.Any> = (
  entityId: string,
) => RpcClient.RpcClient.From<Rpcs, GatewayError>;

/** What an instance's constructor runs with: once per instance. */
export type InstanceServices =
  | RuntimeContext
  | Scope
  | EffectEntity.CurrentAddress
  | EffectEntity.CurrentRunnerAddress;

/** Services the Construction phase may use without the caller providing them. */
export type EntityServices = Entity | Providers | RuntimeContext | Self | Self<Entity>;

type ClassRequirements<Req> = Providers | Exclude<Req, EntityServices | PlatformServices>;

/** The RPC schema shared by an entity and its callers. */
export interface EntitySchema<Rpcs extends Rpc.Any> {
  /** The RPCs the entity answers, as an `RpcGroup`. */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
}

/** Where an entity runs: deploy configuration, not runtime code. */
export interface EntityPlacement<RunnersReq> {
  /**
   * The runners that host the entity, such as
   * `ClusterDocker.Runners("Default")`. Deploying places the entity in their
   * bundle and shard group.
   */
  readonly runners: Layer.Layer<RunnersHost, never, RunnersReq>;
}

/**
 * An entity's implementation. The outer Effect runs once per runner and
 * resolves bindings; the inner one runs once per instance and returns the
 * instance's handlers as an object, one per RPC in the schema.
 */
export type EntityImpl<Rpcs extends Rpc.Any, InitReq> = Effect.Effect<
  Effect.Effect<EffectEntity.HandlersFrom<Rpcs>, never, InstanceServices>,
  ConfigError.ConfigError,
  InitReq
>;

/** What every declared class carries, whatever its form. */
type ClassMembers<Type extends string, Rpcs extends Rpc.Any> = Named<Type> &
  PlatformIdentity<Type> & {
    /**
     * The Effect Cluster entity behind the class, for Effect Cluster's own
     * APIs: `Counter.entity.client` inside runners, `EntityProxy`,
     * `Entity.makeTestClient`.
     */
    readonly entity: EffectEntity.Entity<Type, Rpcs>;
    new (_: never): EntityClient<Rpcs>;
  };

/** Props of an external entity: an existing Effect Cluster program, run as it is. */
export interface ExternalEntityProps {
  /**
   * The module that exports the entity's schema (or the Effect Cluster
   * entity itself), relative to where the deploy runs. The gateway imports
   * it to serve the entity's RPCs.
   */
  main: string;
  /**
   * The export of {@link main} that holds the schema or entity.
   * @default the entity's type
   */
  handler?: string;
  /**
   * Your existing Effect Cluster program, relative to where the deploy
   * runs: one that launches its entities on `NodeClusterHttp` with HTTP
   * transport and SQL storage. It is bundled and run on every runner as it
   * is, with `HOST`, `PORT` and `DATABASE_URL` set.
   */
  program: string;
}

/** The class surface of {@link Entity}. */
export interface EntityClass {
  /**
   * An external entity: an existing Effect Cluster program, referenced by
   * file and run as it is. Provide a runners Layer to it.
   */
  <const Type extends string, Rpcs extends Rpc.Any, RunnersReq>(
    type: Type,
    props: EntitySchema<Rpcs> & EntityPlacement<RunnersReq> & ExternalEntityProps,
  ): Effect.Effect<EntityClient<Rpcs>, never, Providers | RunnersReq> & {
    readonly entity: EffectEntity.Entity<Type, Rpcs>;
  };
  // `Self` names the class (`extends Cluster.Entity<Counter>()`).
  <Self>(): {
    /** Implemented inline. */
    <const Type extends string, Rpcs extends Rpc.Any, RunnersReq, InitReq = never>(
      type: Type,
      props: InputProps<EntityProps> & EntitySchema<Rpcs> & EntityPlacement<RunnersReq>,
      impl: EntityImpl<Rpcs, InitReq>,
    ): Effect.Effect<EntityClient<Rpcs>, never, ClassRequirements<InitReq | RunnersReq>> &
      ClassMembers<Type, Rpcs>;
    /** A declaration callers import, implemented by `.make(props, impl)`. */
    <const Type extends string, Rpcs extends Rpc.Any>(
      type: Type,
      props: EntitySchema<Rpcs>,
    ): Effect.Effect<EntityClient<Rpcs>, never, Providers> &
      ClassMembers<Type, Rpcs> &
      TagMake<Self, Rpcs>;
  };
}

/** The `.make` of a declared tag: its implementation, as a Layer. */
export interface TagMake<Self, Rpcs extends Rpc.Any> {
  make<RunnersReq, InitReq = never>(
    props: InputProps<EntityProps> & EntityPlacement<RunnersReq>,
    impl: EntityImpl<Rpcs, InitReq>,
  ): Layer.Layer<Self, never, ClassRequirements<InitReq | RunnersReq>>;
}

/** The entity was deployed without a runners Layer, so nothing would host it. */
export class EntityHasNoRunners extends Data.TaggedError("Cluster.EntityHasNoRunners")<{
  readonly message: string;
}> {}

/** A class yielded outside any runtime was called. */
export class EntityCalledOutsideRuntime extends Data.TaggedError(
  "Cluster.EntityCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

/**
 * An entity class as a runner runs it: the Effect entity, the instance
 * constructor its Construction phase returned, and the services that phase
 * ran with.
 * @internal
 */
export interface HostedEntity {
  readonly entity: EffectEntity.Entity<string, Rpc.Any>;
  readonly instance: Effect.Effect<Record<string, unknown>, never, any>;
  readonly context: Context.Context<never>;
  readonly options: Pick<EntityProps, "maxIdleTime" | "concurrency">;
}

/** Declares the runners resources for one entity, given its collected env. @internal */
export type DeployToRunners = (env: Record<string, unknown>) => Effect.Effect<void, never, any>;

export interface EntityRuntimeContext extends HostRuntimeContext {
  readonly Type: EntityTypeId;
  readonly alwaysServe: true;
  /** The Effect entity this class hosts. @internal */
  readonly entity: EffectEntity.Entity<string, Rpc.Any>;
  /**
   * Called by a runners Layer while the Construction phase runs: `deploy`
   * declares the runners that host this class, once its env is collected.
   * @internal
   */
  readonly registerRunners: (deploy: DeployToRunners) => Effect.Effect<void>;
  /** At runtime, the built class, once its Construction phase has run. @internal */
  readonly hosted: () => HostedEntity | undefined;
}

/** The Effect entity behind each declared type, for the runtime context. */
const entities = new Map<string, EffectEntity.Entity<string, Rpc.Any>>();

const createRuntimeContext = (id: string): EntityRuntimeContext => {
  const base = createHostRuntimeContext(EntityTypeId)(id);
  let deploy: DeployToRunners | undefined;
  let hosted: HostedEntity | undefined;

  const ctx: EntityRuntimeContext = {
    ...base,
    Type: EntityTypeId,
    // The Construction phase returns the instance constructor rather than a
    // handler shape: always hand it to `serve`.
    alwaysServe: true,
    get entity() {
      return entities.get(id)!;
    },
    registerRunners: (next) =>
      Effect.sync(() => {
        deploy = next;
      }),
    hosted: () => hosted,
    serve: (_handler, options) =>
      Effect.gen(function* () {
        const instance = options?.shape as unknown as HostedEntity["instance"];
        if (globalThis.__ALCHEMY_RUNTIME__) {
          const props = (ctx as unknown as { Props?: EntityProps }).Props;
          hosted = {
            entity: ctx.entity,
            instance,
            context: yield* Effect.context<never>(),
            options: { maxIdleTime: props?.maxIdleTime, concurrency: props?.concurrency },
          };
          return;
        }
        if (deploy === undefined) {
          return yield* Effect.die(
            new EntityHasNoRunners({
              message:
                `Cluster.Entity '${id}' has no runners. Set its \`runners\` prop, ` +
                `for example ClusterDocker.Runners("Default").`,
            }),
          );
        }
        // The Construction phase has run, so every Config value it read is in `env`.
        yield* deploy(base.env);
      }),
  };
  return ctx;
};

type EntityPlatform = Platform<Entity, EntityServices, unknown, EntityRuntimeContext>;

const platform = Platform(EntityTypeId, { createRuntimeContext }) as EntityPlatform;

/** The resource type behind every class, which the providers register. @internal */
export const EntityResource = platform;

/** The Platform declaration behind a class, which a runner builds. @internal */
export const PlatformDeclaration = Symbol.for("alchemy/Cluster/Entity/Platform");

/** The Effect entity a class hosts, which a runner reads. @internal */
export const EntityDefinition = Symbol.for("alchemy/Cluster/Entity/Definition");

/**
 * An **Entity** in an Effect Cluster: a stateful, addressable instance per
 * entity id, whose messages are typed by an `RpcGroup` schema. Runners place
 * each instance on one runner and deliver its messages one at a time.
 *
 * The implementation has two phases. The outer Effect runs once per runner
 * and resolves bindings. The inner Effect runs once per instance, on its
 * first message, and returns its handlers as an object literal.
 *
 * Where it runs is the `runners` prop: a runners Layer such as
 * `ClusterDocker.Runners("Default")`, given the database the runners
 * coordinate through.
 *
 * `yield* Counter` from any runtime returns a client with the same shape as
 * Effect Cluster's `Entity.client`: `counters("counter-1").Increment(...)`.
 * Calls go through the runners' gateway over HTTP, so callers need no
 * database access and no route to the runners.
 *
 * ### Declaring an entity
 * **Example:** A counter, implemented inline
 * ```typescript
 * export class CounterRpcs extends RpcGroup.make(
 *   Rpc.make("Increment", { payload: { amount: Schema.Int }, success: Schema.Int }),
 * ) {}
 *
 * export default class Counter extends Cluster.Entity<Counter>()(
 *   "Counter",
 *   { main: import.meta.url, schema: CounterRpcs, runners: Default },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const count = yield* Ref.make(0);
 *       return {
 *         Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** A declaration callers import, and its implementation as a Layer
 * ```typescript
 * export class Counter extends Cluster.Entity<Counter>()("Counter", { schema: CounterRpcs }) {}
 *
 * export const CounterLive = Counter.make(
 *   { main: import.meta.url, handler: "CounterLive", runners: Default },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const count = yield* Ref.make(0);
 *       return {
 *         Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * **Example:** An existing Effect Cluster program, run as it is
 * ```typescript
 * import { Counter as CounterEntity } from "./entities/counter.ts";
 *
 * export const Counter = Cluster.Entity("Counter", {
 *   schema: CounterEntity.protocol,
 *   main: "./entities/counter.ts",
 *   program: "./runner.ts",
 *   runners: Legacy,
 * });
 * ```
 *
 * ### Calling an entity
 * **Example:** From any runtime
 * ```typescript
 * const counters = yield* Counter;
 * const count = yield* counters("visits").Increment({ amount: 1 });
 * ```
 *
 * @resource
 */
export const Entity: EntityClass = ((...outer: ReadonlyArray<unknown>) =>
  outer.length > 0
    ? external(
        outer[0] as string,
        outer[1] as EntitySchema<Rpc.Any> & EntityPlacement<unknown> & ExternalEntityProps,
      )
    : (type: string, props: EntitySchema<Rpc.Any> & Partial<EntityProps>, impl?: unknown) => {
        const entity = placedInRunnersGroup(EffectEntity.fromRpcGroup(type, props.schema));
        entities.set(type, entity);
        if (impl !== undefined)
          return declare(entity, (platform as any)()(type, ...placed(props, impl)));
        const tag = (platform as any)()(type);
        return declare(entity, tag, {
          make: (makeProps: Partial<EntityPlacement<unknown> & EntityProps>, makeImpl: unknown) =>
            tag.make(...placed(makeProps, makeImpl)),
        });
      }) as unknown as EntityClass;

/**
 * Split the schema and runners off the deployed props, and provide the
 * runners to the Construction phase. Placement is deploy configuration, so
 * the implementation stays a bare Effect and its handlers an object literal
 * typed by the schema.
 */
const placed = (
  props: Partial<EntitySchema<Rpc.Any> & EntityPlacement<unknown> & EntityProps>,
  impl: unknown,
) => {
  const { schema: _schema, runners, ...rest } = props;
  return [
    rest,
    runners === undefined
      ? impl
      : Effect.provide(impl as Effect.Effect<unknown, unknown, RunnersHost>, runners),
  ] as const;
};

/** The environment key holding the shard group an entity's runners serve. @internal */
export const shardGroupKey = (type: string) => sanitizeKey(`CLUSTER_${type}_SHARD_GROUP`);

/**
 * Place an entity in its runners' shard group, read when a message is
 * routed: its runners, and every runtime that yields the class, have it in
 * their environment. Effect Cluster's own client (`Counter.entity.client`)
 * then routes to the right runners too.
 */
const placedInRunnersGroup = (entity: EffectEntity.Entity<string, Rpc.Any>) => {
  const key = shardGroupKey(entity.type);
  return entity.annotate(
    ClusterSchema.ShardGroup,
    // A synchronous lookup at routing time; workerd has no `process`.
    () =>
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[key] ??
      "default",
  );
};

/**
 * An external entity: declare its resource, then have the runners it was
 * given run its program. The runners Layer is what provides `RunnersHost`.
 */
const external = (
  type: string,
  props: EntitySchema<Rpc.Any> & EntityPlacement<unknown> & ExternalEntityProps,
) => {
  // The program keeps its own shard groups: the entity is not placed in
  // the runners' group.
  const entity = EffectEntity.fromRpcGroup(type, props.schema);
  entities.set(type, entity);
  const declaration = Effect.gen(function* () {
    const resource = yield* (platform as any)(entity.type, {
      main: props.main,
      handler: props.handler,
    }) as Effect.Effect<Entity, never, Providers>;
    if (globalThis.__ALCHEMY_RUNTIME__) return resource;
    const host = yield* RunnersHost.pipe(Effect.provide(props.runners));
    yield* host.deployExternal({
      type: entity.type,
      main: yield* Effect.sync(() => nodePath.resolve(props.main)),
      handler: props.handler ?? entity.type,
      program: props.program,
      resource,
    });
    return resource;
  });
  return Object.assign(clientOf(entity, declaration), { entity });
};

/**
 * A class whose `yield*` is its client. While deploying it registers the
 * class and binds what a caller needs into the caller's environment; at
 * runtime it only reads them back, so the Construction phase never runs in
 * a caller.
 */
const declare = (
  entity: EffectEntity.Entity<string, Rpc.Any>,
  declaration: any,
  members: { make?: unknown } = {},
) =>
  Object.assign(
    class {},
    members,
    {
      LogicalId: entity.type,
      entity,
      [PlatformDeclaration]: declaration,
      [EntityDefinition]: entity,
    },
    Effectable.Prototype({
      label: `${EntityTypeId}<${entity.type}>`,
      evaluate: () => clientOf(entity, declaration),
    }),
  );

const clientOf = (
  entity: EffectEntity.Entity<string, Rpc.Any>,
  declaration: Effect.Effect<Entity, never, any>,
) =>
  Effect.gen(function* () {
    // Built on a memo map of its own: a class built inside another's phase
    // would otherwise reuse the caller's already-built runners Layer.
    const resource = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* declaration.pipe(
          Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
        );
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    if (ctx === undefined) return outsideRuntime(entity);
    // Bound as environment values while deploying; read back at runtime.
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(
          sanitizeKey(`CLUSTER_${entity.type}_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const url = (yield* bind<string>("GATEWAY", resource?.gateway)) ?? "";
    // The runners' shard group, for Effect Cluster's own client (`.entity.client`).
    yield* bind<string>("SHARD_GROUP", resource?.runners);
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", resource?.token);
    return makeGatewayClient(entity, {
      url,
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
    }) as unknown as EntityClient<Rpc.Any>;
  });

const outsideRuntime = (entity: EffectEntity.Entity<string, Rpc.Any>) =>
  ((entityId: string) => {
    const fail = () =>
      Effect.die(
        new EntityCalledOutsideRuntime({
          message: `Cluster.Entity '${entity.type}/${entityId}' can only be called inside a runtime.`,
        }),
      );
    return new Proxy({}, { get: () => fail });
  }) as unknown as EntityClient<Rpc.Any>;

export const EntityProvider = () =>
  Provider.succeed(platform, {
    stables: ["type"],
    reconcile: ({ id, bindings }) =>
      Effect.sync(() => {
        const attrs: EntityAttributes = {
          type: id,
          runners: undefined,
          gateway: undefined,
          token: undefined,
        };
        for (const { data } of bindings) {
          attrs.runners = data.runners ?? attrs.runners;
          attrs.gateway = data.gateway ?? attrs.gateway;
          attrs.token = data.token ?? attrs.token;
        }
        return attrs;
      }),
    delete: () => Effect.void,
  });

export type { RpcGroup };
