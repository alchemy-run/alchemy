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
import type { Entity as EffectEntity } from "effect/cluster";
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
import type { Providers } from "./Providers.ts";

export const EntityTypeId = "EffectCluster.Entity";
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
  /** The runners that host it. */
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

type ClassProps<PropsReq> =
  | InputProps<EntityProps>
  | Effect.Effect<InputProps<EntityProps>, ConfigError.ConfigError, PropsReq>;

type ClassRequirements<Req> = Providers | Exclude<Req, EntityServices | PlatformServices>;

/** The class surface of {@link Entity}. */
export interface EntityClass {
  // `Self` names the class (`extends EffectCluster.Entity<Counters>()`).
  <_Self>(): <
    const Type extends string,
    Rpcs extends Rpc.Any,
    Handlers extends EffectEntity.HandlersFrom<Rpcs>,
    PropsReq = never,
    InitReq = never,
  >(
    entity: EffectEntity.Entity<Type, Rpcs>,
    props: ClassProps<PropsReq>,
    impl: Effect.Effect<
      Effect.Effect<Handlers, never, InstanceServices>,
      ConfigError.ConfigError,
      InitReq
    >,
  ) => Effect.Effect<EntityClient<Rpcs>, never, ClassRequirements<PropsReq | InitReq>> &
    Named<Type> &
    PlatformIdentity<Type> & {
      new (_: never): EntityClient<Rpcs>;
    };
}

/** The entity was deployed without a runners Layer, so nothing would host it. */
export class EntityHasNoRunners extends Data.TaggedError("EffectCluster.EntityHasNoRunners")<{
  readonly message: string;
}> {}

/** A class yielded outside any runtime was called. */
export class EntityCalledOutsideRuntime extends Data.TaggedError(
  "EffectCluster.EntityCalledOutsideRuntime",
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
                `EffectCluster.Entity '${id}' has no runners. Provide a runners Layer to its Effect, ` +
                `for example EffectClusterDocker.Runners("Default").`,
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
export const PlatformDeclaration = Symbol.for("alchemy/EffectCluster/Entity/Platform");

/** The Effect entity a class hosts, which a runner reads. @internal */
export const EntityDefinition = Symbol.for("alchemy/EffectCluster/Entity/Definition");

/**
 * An **Entity** in an Effect Cluster: a stateful, addressable instance per
 * entity id, whose messages are typed by the Effect entity's RPC schemas.
 * Runners place each instance on one runner and deliver its messages one at
 * a time.
 *
 * The implementation has two phases. The outer Effect runs once per runner
 * and resolves bindings. The inner Effect runs once per instance, on its
 * first message, and returns its handlers.
 *
 * Where it runs is a runners Layer provided to the outer Effect —
 * `EffectClusterDocker.Runners("Default")` — given the database the
 * runners coordinate through.
 *
 * `yield* Counter` from any runtime returns a client with the same shape as
 * Effect Cluster's `Entity.client`: `counters("counter-1").Increment(...)`.
 * Calls go through the runners' gateway over HTTP, so callers need no
 * database access and no route to the runners.
 *
 * ### Declaring an entity
 * **Example:** A counter on local runners
 * ```typescript
 * export const Increment = Rpc.make("Increment", {
 *   payload: { amount: Schema.Int },
 *   success: Schema.Int,
 * });
 *
 * export const Counter = Entity.make("Counter", [Increment]);
 *
 * export default class Counters extends EffectCluster.Entity<Counters>()(
 *   Counter,
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const count = yield* Ref.make(0);
 *       return {
 *         Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
 *       };
 *     });
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * ### Calling an entity
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * const counters = yield* Counters;
 * const count = yield* counters("visits").Increment({ amount: 1 });
 * ```
 *
 * @resource
 */
export const Entity: EntityClass = (() =>
  (entity: EffectEntity.Entity<string, Rpc.Any>, props?: unknown, impl?: unknown) => {
    entities.set(entity.type, entity);
    return declare(entity, (platform as any)()(entity.type, props, impl));
  }) as unknown as EntityClass;

/**
 * A class whose `yield*` is its client. While deploying it registers the
 * class and binds what a caller needs into the caller's environment; at
 * runtime it only reads them back, so the Construction phase never runs in
 * a caller.
 */
const declare = (entity: EffectEntity.Entity<string, Rpc.Any>, declaration: any) =>
  Object.assign(
    class {},
    { LogicalId: entity.type, [PlatformDeclaration]: declaration, [EntityDefinition]: entity },
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
          sanitizeKey(`EFFECT_CLUSTER_${entity.type}_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const url = (yield* bind<string>("GATEWAY", resource?.gateway)) ?? "";
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
          message: `EffectCluster.Entity '${entity.type}/${entityId}' can only be called inside a runtime.`,
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
