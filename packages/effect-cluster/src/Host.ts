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

/**
 * The header a call carries the id of a WebSocket under, when a caller
 * opened one to the instance's object with `EntityNamespace.connect`. The
 * call's handler takes the socket with {@link InstanceSockets}'s `accept`.
 */
export const SOCKET_HEADER = "x-cluster-socket";

/** A WebSocket held by the object an entity instance runs on. */
export interface InstanceSocket {
  send(message: string): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  /** Keep a value with the socket: it outlives the instance in memory, as the socket does. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment<T>(): T | null;
}

/**
 * The WebSockets of the object an entity instance runs on, on pools whose
 * instances each have an object that holds them
 * (`ClusterCloudflare.DurableObjectPool`: hibernatable WebSockets of the
 * instance's Durable Object). A socket stays open while the object is
 * evicted, and `all` finds it again once the instance runs. Messages from
 * the client are ignored. On other pools, the service is absent.
 */
export class InstanceSockets extends Context.Service<
  InstanceSockets,
  {
    /**
     * Take the socket a call carries the id of under {@link SOCKET_HEADER}.
     * A socket no handler takes is closed once its call ends.
     */
    readonly accept: (id: string) => Effect.Effect<InstanceSocket | undefined>;
    /** Every socket the object holds. */
    readonly all: Effect.Effect<ReadonlyArray<InstanceSocket>>;
  }
>()("Cluster.InstanceSockets") {}
