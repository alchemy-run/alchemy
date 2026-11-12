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
import { bindRoute, makeNamespace } from "./internal/Gateway.ts";
import { type HostedRuntimeContext, makeHostedRuntimeContext } from "./internal/HostedRuntime.ts";
import { PoolHost } from "./internal/PoolHostService.ts";
import type { Providers } from "./Providers.ts";

export const EntityTypeId = "Cluster.Entity";
export type EntityTypeId = typeof EntityTypeId;

export interface EntityProps extends PlatformProps {
  /**
   * The module that exports this entity: the class, or the Layer its
   * `.make(...)` returned. Usually `import.meta.url`.
   */
  main: string;
  /**
   * The export of {@link main} that holds this entity.
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
   * How many of an instance's messages run at once. A handler that returns
   * `Rpc.fork(...)` runs outside this limit.
   * @default 1
   */
  concurrency?: number | "unbounded";
  /**
   * How many messages an instance may hold, running or waiting to run.
   * Past that, a message fails with `MailboxFull`, unless it is persisted:
   * a persisted message is stored and runs once there is room.
   * @default 4096
   */
  mailboxCapacity?: number | "unbounded";
  /**
   * Return a handler's defect to its caller instead of restarting the
   * instance. By default, as on Effect Cluster's runners, a defect rebuilds
   * the instance and runs its messages again, backing off between restarts.
   * @default false
   */
  disableFatalDefects?: boolean;
}

export interface EntityAttributes {
  /** The entity type: the class's logical id. */
  type: string;
  /** The shard group of the pool that hosts it. */
  pool: string | undefined;
  /** The gateway URL callers send requests to. */
  gateway: string | undefined;
  /** The token callers present to the gateway. */
  token: Redacted.Redacted<string> | undefined;
}

/** Data a pool Layer binds onto the entities it hosts. */
export interface EntityBindingContract {
  pool?: string;
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

/**
 * Every instance of one entity type. `getByName(entityId)` returns a client
 * with the same shape as Effect Cluster's `Entity.client(entityId)`; its
 * calls take Effect's client options (`discard`, `headers`).
 */
export interface EntityNamespace<Rpcs extends Rpc.Any> {
  readonly getByName: (
    entityId: string,
  ) => Effect.Effect<
    RpcClient.RpcClient.From<Rpcs, GatewayError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
}

/** What an instance's constructor runs with: once per instance. */
export type InstanceServices =
  | RuntimeContext
  | Scope
  | EffectEntity.CurrentAddress
  | EffectEntity.CurrentRunnerAddress;

/** Services the Construction phase may use without the caller providing them. */
export type EntityServices = Entity | Providers | RuntimeContext | Self | Self<Entity>;

type ClassRequirements<Req> = Providers | Exclude<Req, EntityServices | PlatformServices>;

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

/**
 * A declared entity: the tag callers `yield*`, carrying Effect Cluster's
 * entity surface (`.of`, `.protocol`, `.entity`), implemented by
 * `.make(props, impl)`.
 */
export type EntityTag<Self, Type extends string, Rpcs extends Rpc.Any> = Effect.Effect<
  EntityNamespace<Rpcs>,
  never,
  Providers
> &
  Named<Type> &
  PlatformIdentity<Type> & {
    /**
     * The Effect Cluster entity behind the class, for Effect Cluster's own
     * APIs: `Counter.entity.client` inside runners, `EntityProxy`,
     * `Entity.makeTestClient`.
     */
    readonly entity: EffectEntity.Entity<Type, Rpcs>;
    /** The entity's RPCs, as an `RpcGroup`. */
    readonly protocol: RpcGroup.RpcGroup<Rpcs>;
    /** Type an instance's handlers against the entity's RPCs, as Effect Cluster's `Entity.of`. */
    of<Handlers extends EffectEntity.HandlersFrom<Rpcs>>(handlers: Handlers): Handlers;
    /**
     * The entity's implementation, as a Layer. Provide a pool Layer to
     * `impl` to deploy it, with its RPCs' middleware provided to the pool;
     * then provide the returned Layer to the Stack.
     */
    make<InitReq = never>(
      props: InputProps<EntityProps>,
      impl: EntityImpl<Rpcs, InitReq>,
    ): Layer.Layer<Self, never, ClassRequirements<InitReq>>;
    new (_: never): EntityNamespace<Rpcs>;
  };

/**
 * An entity declared with its implementation: the class callers `yield*`,
 * which also deploys it.
 */
export type EntityInline<Type extends string, Rpcs extends Rpc.Any, Req> = Effect.Effect<
  EntityNamespace<Rpcs>,
  never,
  Req
> &
  Named<Type> &
  PlatformIdentity<Type> & {
    /** The Effect Cluster entity behind the class, for Effect Cluster's own APIs. */
    readonly entity: EffectEntity.Entity<Type, Rpcs>;
    /** The entity's RPCs, as an `RpcGroup`. */
    readonly protocol: RpcGroup.RpcGroup<Rpcs>;
    /** Type an instance's handlers against the entity's RPCs, as Effect Cluster's `Entity.of`. */
    of<Handlers extends EffectEntity.HandlersFrom<Rpcs>>(handlers: Handlers): Handlers;
    new (_: never): EntityNamespace<Rpcs>;
  };

/** Props of an external entity: an existing Effect Cluster program, run as it is. */
export interface ExternalEntityProps {
  /**
   * The module that exports the Effect Cluster entity, under its type's
   * name, relative to where the deploy runs. The gateway imports it to
   * serve the entity's RPCs.
   */
  main: string;
  /**
   * Your existing Effect Cluster program, relative to where the deploy
   * runs: one that launches its entities on `NodeClusterHttp` with HTTP
   * transport and SQL storage. It is bundled into the pool and run as
   * its own process on every runner, with `HOST`, `PORT` and `DATABASE_URL` set.
   */
  program: string;
}

/** The class surface of {@link Entity}. */
export interface EntityClass {
  /**
   * An external entity: an existing Effect Cluster program, run as it is.
   * Provide a pool Layer to deploy it.
   */
  <const Type extends string, Rpcs extends Rpc.Any>(
    entity: EffectEntity.Entity<Type, Rpcs>,
    props: ExternalEntityProps,
  ): Effect.Effect<EntityNamespace<Rpcs>, never, PoolHost | Providers> & {
    readonly entity: EffectEntity.Entity<Type, Rpcs>;
  };
  // `Self` names the class (`extends Cluster.Entity<Counter>()`).
  <Self>(): {
    /**
     * Declared from an Effect Cluster entity, with its implementation, which
     * types its handlers with the entity's `.of`. Provide a pool Layer to
     * `impl` to deploy it, with its RPCs' middleware provided to the pool.
     */
    <const Type extends string, Rpcs extends Rpc.Any, InitReq = never>(
      entity: EffectEntity.Entity<Type, Rpcs>,
      props: InputProps<EntityProps>,
      impl: EntityImpl<Rpcs, InitReq>,
    ): EntityInline<Type, Rpcs, ClassRequirements<InitReq>>;
    /** Declared from its RPCs, as Effect Cluster's `Entity.make`. */
    <const Type extends string, const Rpcs extends ReadonlyArray<Rpc.Any>>(
      type: Type,
      rpcs: Rpcs,
    ): EntityTag<Self, Type, Rpcs[number]>;
    /** Declared from an existing Effect Cluster entity. */
    <const Type extends string, Rpcs extends Rpc.Any>(
      entity: EffectEntity.Entity<Type, Rpcs>,
    ): EntityTag<Self, Type, Rpcs>;
  };
}

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
  readonly kind: "entity";
  readonly entity: EffectEntity.Entity<string, Rpc.Any>;
  readonly instance: Effect.Effect<Record<string, unknown>, never, any>;
  readonly context: Context.Context<never>;
  readonly options: Pick<
    EntityProps,
    "maxIdleTime" | "concurrency" | "mailboxCapacity" | "disableFatalDefects"
  >;
}

export type EntityRuntimeContext = HostedRuntimeContext<HostedEntity>;

/** The Effect entity behind each declared type, for the runtime context. */
const entities = new Map<string, EffectEntity.Entity<string, Rpc.Any>>();

const createRuntimeContext = makeHostedRuntimeContext<HostedEntity>(
  EntityTypeId,
  (id, instance, context, props?: EntityProps) => ({
    kind: "entity",
    entity: entities.get(id)!,
    instance: instance as HostedEntity["instance"],
    context,
    options: {
      maxIdleTime: props?.maxIdleTime,
      concurrency: props?.concurrency,
      mailboxCapacity: props?.mailboxCapacity,
      disableFatalDefects: props?.disableFatalDefects,
    },
  }),
  // Every RPC's middleware must reach the pool with the entity.
  (id, context) => {
    const missing = [...entities.get(id)!.protocol.requests.values()].flatMap((rpc) =>
      [...(rpc as unknown as Rpc.AnyWithProps).middlewares]
        .filter((middleware) => !context.mapUnsafe.has(middleware.key))
        .map((middleware) => `${rpc._tag} uses ${middleware.key}`),
    );
    return missing.length === 0
      ? Effect.void
      : Effect.die(
          new EntityMiddlewareMissing({
            message:
              `Cluster.Entity '${id}' is missing RPC middleware (${missing.join(", ")}). ` +
              `Provide its Layer with the pool: Effect.provide(Default.pipe(Layer.provide(AuthLive))).`,
          }),
        );
  },
);

/** An entity's RPC uses middleware nothing provided to its pool. */
export class EntityMiddlewareMissing extends Data.TaggedError("Cluster.EntityMiddlewareMissing")<{
  readonly message: string;
}> {}

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
 * entity id, whose messages are typed by its RPCs. Runners place each
 * instance on one runner and deliver its messages one at a time.
 *
 * Declare it from an Effect Cluster entity with its implementation, and
 * the class is both what callers `yield*` and what deploys it. Or declare
 * it bare, like Effect Cluster's `Entity.make`, from a type and its RPCs,
 * and implement it with `.make(props, impl)`, as a Layer: callers import
 * the bare declaration without bundling the implementation or its pool.
 *
 * The implementation has two phases. The outer Effect runs once per runner
 * and resolves bindings. The inner Effect runs once per instance, on its
 * first message, and returns its handlers, typed by the entity's `.of`. Providing a
 * pool Layer to the implementation, such as
 * `ClusterDocker.SwarmPool("Default")`, is what deploys it.
 *
 * `yield* Counter` from any runtime returns the entity's namespace, like a
 * Durable Object's: `getByName(entityId)` returns a client with the same
 * shape as Effect Cluster's `Entity.client(entityId)`. Inside the cluster,
 * calls go through Effect Cluster directly; elsewhere they go through the
 * pool's gateway over HTTP, so callers need no database access and no
 * route to the pool.
 *
 * ### Declaring an entity
 * **Example:** A counter, with its implementation
 * ```typescript
 * // src/Counter.ts
 * const Counters = Entity.make("Counter", [
 *   Rpc.make("Increment", { payload: { amount: Schema.Int }, success: Schema.Int }),
 * ]);
 *
 * export default class Counter extends Cluster.Entity<Counter>()(
 *   Counters,
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const count = yield* Ref.make(0);
 *       return Counters.of({
 *         Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
 *       });
 *     });
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * ### Keeping its code out of its callers
 * **Example:** A bare declaration, which callers import
 * ```typescript
 * // src/Counter.ts
 * export const Increment = Rpc.make("Increment", {
 *   payload: { amount: Schema.Int },
 *   success: Schema.Int,
 * });
 *
 * export class Counter extends Cluster.Entity<Counter>()("Counter", [Increment]) {}
 * ```
 *
 * **Example:** An existing Effect Cluster entity
 * ```typescript
 * import { Counter as CounterEntity } from "./entities/counter.ts";
 *
 * export class Counter extends Cluster.Entity<Counter>()(CounterEntity) {}
 * ```
 *
 * **Example:** Its implementation, as a Layer, deployed to a pool
 * ```typescript
 * // src/CounterLive.ts
 * export default Counter.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const count = yield* Ref.make(0);
 *       return Counter.of({
 *         Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
 *       });
 *     });
 *   }).pipe(Effect.provide(Default)),
 * );
 * ```
 *
 * **Example:** Middleware, provided with the pool
 * ```typescript
 * export const Increment = Rpc.make("Increment", {
 *   payload: { amount: Schema.Int },
 *   success: Schema.Int,
 * }).middleware(Auth);
 *
 * export default Counter.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       return Counter.of({
 *         Increment: () => Effect.map(CurrentUser, (user) => user.id.length),
 *       });
 *     });
 *   }).pipe(Effect.provide(Default.pipe(Layer.provide(AuthLive)))),
 * );
 * ```
 *
 * **Example:** An existing Effect Cluster program, run as it is
 * ```typescript
 * import { Tally as TallyEntity } from "./entities/tally.ts";
 *
 * export const Tally = Cluster.Entity(TallyEntity, {
 *   main: "./entities/tally.ts",
 *   program: "./runner.ts",
 * }).pipe(Effect.provide(Legacy));
 * ```
 *
 * ### Calling an entity
 * **Example:** From any runtime
 * ```typescript
 * const counters = yield* Counter;
 * const counter = yield* counters.getByName("visits");
 * const count = yield* counter.Increment({ amount: 1 });
 * ```
 *
 * **Example:** Without waiting for the reply
 * ```typescript
 * yield* counter.Increment({ amount: 1 }, { discard: true });
 * ```
 *
 * **Example:** Through client middleware
 * ```typescript
 * const counter = yield* counters.getByName("visits");
 * yield* counter.Increment({ amount: 1 }).pipe(Effect.provide(AuthClient));
 * ```
 *
 * @resource
 */
export const Entity: EntityClass = ((...outer: ReadonlyArray<unknown>) =>
  outer.length > 0
    ? external(outer[0] as AnyEntity, outer[1] as ExternalEntityProps)
    : (typeOrEntity: string | AnyEntity, ...rest: ReadonlyArray<unknown>) => {
        const [rpcs, props, impl] = typeof typeOrEntity === "string" ? rest : [undefined, ...rest];
        const entity = placedInShardGroup(
          typeof typeOrEntity === "string"
            ? EffectEntity.make(typeOrEntity, rpcs as ReadonlyArray<Rpc.Any>)
            : typeOrEntity,
        );
        entities.set(entity.type, entity);
        const members = { of: (handlers: unknown) => handlers, protocol: entity.protocol };
        // With an implementation, the class deploys it; without, `.make` does.
        if (impl !== undefined) {
          return declare(entity, (platform as any)()(entity.type, props, impl), members);
        }
        const tag = (platform as any)()(entity.type);
        return declare(entity, tag, { ...members, make: tag.make });
      }) as unknown as EntityClass;

type AnyEntity = EffectEntity.Entity<string, Rpc.Any>;

/** The environment key holding the shard group an entity's pool serves. @internal */
export const shardGroupKey = (type: string) => sanitizeKey(`CLUSTER_${type}_SHARD_GROUP`);

/**
 * Place an entity in its pool's shard group, read when a message is
 * routed: its pool, and every runtime that yields the class, have it in
 * their environment. Effect Cluster's own client (`Counter.entity.client`)
 * then routes to the right pool too.
 */
const placedInShardGroup = (entity: AnyEntity) => {
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
 * An external entity: declare its resource, then have the pool it was
 * given run its program. The pool Layer is what provides `PoolHost`.
 */
const external = (entity: AnyEntity, props: ExternalEntityProps) => {
  entities.set(entity.type, entity);
  const declaration = Effect.gen(function* () {
    const resource = yield* (platform as any)(entity.type, {
      main: props.main,
    }) as Effect.Effect<Entity, never, Providers>;
    if (globalThis.__ALCHEMY_RUNTIME__) return resource;
    const host = yield* PoolHost;
    yield* host.deployExternal({
      type: entity.type,
      main: yield* Effect.sync(() => nodePath.resolve(props.main)),
      handler: entity.type,
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
const declare = (entity: AnyEntity, declaration: any, members: object) =>
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

const clientOf = (entity: AnyEntity, declaration: Effect.Effect<Entity, never, any>) =>
  Effect.gen(function* () {
    // Built on a memo map of its own: a class built inside another's phase
    // would otherwise reuse the caller's already-built pool Layer.
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
    // The pool's shard group, for Effect Cluster's own client (`.entity.client`).
    yield* bind<string>("SHARD_GROUP", resource?.pool);
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", resource?.token);
    // A Worker calling a gateway Worker reaches it through a service binding.
    const service = sanitizeKey(`CLUSTER_${entity.type}_SERVICE`);
    if (!globalThis.__ALCHEMY_RUNTIME__) yield* bindRoute(entity.type, service);
    return makeNamespace(entity, {
      url,
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
      service,
    }) as unknown as EntityNamespace<Rpc.Any>;
  });

const outsideRuntime = (entity: AnyEntity): EntityNamespace<Rpc.Any> => ({
  getByName: (entityId) =>
    Effect.die(
      new EntityCalledOutsideRuntime({
        message: `Cluster.Entity '${entity.type}/${entityId}' can only be called inside a runtime.`,
      }),
    ),
});

export const EntityProvider = () =>
  Provider.succeed(platform, {
    stables: ["type"],
    reconcile: ({ id, bindings }) =>
      Effect.sync(() => {
        const attrs: EntityAttributes = {
          type: id,
          pool: undefined,
          gateway: undefined,
          token: undefined,
        };
        for (const { data } of bindings) {
          attrs.pool = data.pool ?? attrs.pool;
          attrs.gateway = data.gateway ?? attrs.gateway;
          attrs.token = data.token ?? attrs.token;
        }
        return attrs;
      }),
    delete: () => Effect.void,
  });

export type { RpcGroup };
