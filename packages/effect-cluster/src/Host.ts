/**
 * What a platform built on Effect Cluster entities, such as
 * `@alchemy.run/domain/EffectCluster`, needs from the runner it is built on
 * and from the gateway its callers reach entities through.
 *
 * @module
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HostedEntity } from "./Entity.ts";

export { type GatewayTarget, makeNamespace } from "./internal/Gateway.ts";
export { HasNoPool } from "./internal/HostedRuntime.ts";

/**
 * The runner a Layer is being built on. A runner's bootstrap provides it
 * while it builds its entrypoints, so a Layer that hosts an entity itself
 * (a Domain platform's, built by the model's Layer rather than exported as
 * a class) hands the runner that entity, and the Layer to launch with it
 * inside the cluster (with Sharding and the workflow engine). Anywhere
 * else, the service is absent.
 */
export class RunnerHost extends Context.Service<
  RunnerHost,
  {
    /** Host an entity on this runner, launching `layer` in the cluster beside it. */
    readonly host: (
      entity: HostedEntity,
      layer: Layer.Layer<never, never, any>,
    ) => Effect.Effect<void>;
  }
>()("Cluster.RunnerHost") {}

/** Options for {@link InstanceStorage}'s `list`. Keys come back in order. */
export interface InstanceStorageListOptions {
  /** Only keys that start with this prefix. */
  readonly prefix?: string;
  /** Only keys at or after this key. */
  readonly start?: string;
  /** Only keys after this key. */
  readonly startAfter?: string;
  /** Only keys before this key. */
  readonly end?: string;
  /** At most this many entries. */
  readonly limit?: number;
}

/**
 * The key-value storage of the object an entity instance runs on, on pools
 * that give every instance an object of its own
 * (`ClusterCloudflare.DurableObjectPool`: the instance's Durable Object).
 * Values are structured-cloneable; writes inside `transaction` commit
 * together, or not at all. The pool provides it to every instance it runs;
 * on pools that share one database, the service is absent.
 */
export class InstanceStorage extends Context.Service<
  InstanceStorage,
  {
    get<T>(key: string): Effect.Effect<T | undefined>;
    put<T>(key: string, value: T): Effect.Effect<void>;
    put<T>(entries: Record<string, T>): Effect.Effect<void>;
    delete(key: string): Effect.Effect<boolean>;
    delete(keys: ReadonlyArray<string>): Effect.Effect<number>;
    list<T>(options?: InstanceStorageListOptions): Effect.Effect<Map<string, T>>;
    transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  }
>()("Cluster.InstanceStorage") {}
