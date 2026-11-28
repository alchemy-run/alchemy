import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
/**
 * An object with storage, an alarm and methods of its own, on any platform
 * that has one: a Cloudflare Durable Object, a Rivet actor, an Effect
 * Cluster entity. This is the contract. Each platform package provides an
 * {@link ObjectHost}; what is built on objects (Domain's models, AI's
 * sessions) asks it for classes and never names a platform.
 *
 * @module
 */
import type { Callbacks } from "../Callback.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** Options for {@link ObjectStorage.list}. Keys come back in order. */
export interface ListOptions {
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
  /** Keys in descending order: `limit` counts from the end. */
  readonly reverse?: boolean;
}

/**
 * An object's own key-value storage. Values are structured-cloneable (plain
 * JSON is enough for everything Domain stores). Writes inside `transaction`
 * commit together, or not at all.
 */
export interface ObjectStorage {
  get<T>(key: string): Effect.Effect<T | undefined>;
  put<T>(key: string, value: T): Effect.Effect<void>;
  put<T>(entries: Record<string, T>): Effect.Effect<void>;
  delete(key: string): Effect.Effect<boolean>;
  delete(keys: ReadonlyArray<string>): Effect.Effect<number>;
  list<T>(options?: ListOptions): Effect.Effect<Map<string, T>>;
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

/** A live read's WebSocket, held by the object that owns its key. */
export interface ObjectSocket {
  send(message: string): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  /** Keep a value with the socket, across hibernation where the host has it. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment<T>(): T | null;
}

/** The instance an object's methods run against. */
export interface ObjectStateShape {
  readonly storage: ObjectStorage;
  /**
   * Run `effect` with every other event on this instance held back, as
   * Cloudflare's `blockConcurrencyWhile` does. Objects call each other only
   * outside it.
   */
  exclusive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Run `effect` in the background, keeping the instance alive until it ends. */
  waitUntil(effect: Effect.Effect<void>): Effect.Effect<void>;
  /**
   * Live reads pushed over WebSockets the object holds. Without it, live
   * reads are streamed responses that poll the object.
   */
  readonly sockets?: {
    /** Accept the current request's upgrade. */
    readonly accept: () => Effect.Effect<
      readonly [HttpServerResponse.HttpServerResponse, ObjectSocket]
    >;
    /** Every socket the instance holds. */
    readonly all: () => Effect.Effect<ReadonlyArray<ObjectSocket>>;
  };
}

/** The running object's state, which a host provides to every instance. */
export class ObjectState extends Context.Service<ObjectState, ObjectStateShape>()(
  "alchemy/Workers/ObjectState",
) {}

/** One object: every method is a call that returns an Effect. */
export interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<any>) => Effect.Effect<unknown, unknown>;
}

/** Every object of one class, by name. */
export interface Namespace {
  readonly getByName: (name: string) => Stub;
}

/** What an instance runs with. */
export type InstanceServices = ObjectState | RuntimeContext | Callbacks | Scope.Scope;

/**
 * An object's implementation: built once per instance, it returns the
 * instance's methods. The host calls them by name with JSON arguments, and
 * hands their JSON results back. A `fetch` method, when there is one, serves
 * the instance's HTTP requests (a live read's WebSocket upgrade).
 */
export type ObjectImpl = Effect.Effect<Record<string, unknown>, never, InstanceServices>;

/** What declaring a class may say about it. A host ignores what it has no use for. */
export interface DeclareOptions {
  /**
   * The class this one takes over from: its objects, by the same names. Only
   * a host whose classes are deployed by name (Cloudflare) moves anything.
   */
  readonly renamedFrom?: string;
}

/**
 * Where objects live. A platform package provides it as a Layer; `declare`
 * is called while another Layer is built on it, and each object then runs
 * wherever that platform runs its objects.
 */
export class ObjectHost extends Context.Service<
  ObjectHost,
  {
    /**
     * Declare a class of objects, and return its namespace: every object of
     * it, by name. Each object is built from `impl` once, on its first call.
     */
    readonly declare: (
      name: string,
      impl: ObjectImpl,
      options?: DeclareOptions,
    ) => Effect.Effect<Namespace>;
    /**
     * A class by name, which code that does not declare it (another isolate
     * of the same deploy) can still reach. Absent where every runtime
     * declares what it calls.
     */
    readonly lookup?: (name: string) => Namespace | undefined;
  }
>()("alchemy/Workers/ObjectHost") {}

/** The key a defect travels under, as data. */
export const DefectTag = "alchemy/Workers/Defect";

/**
 * Calls between objects may lose thrown errors (Workers RPC replaces them
 * with an opaque "internal error"). Return failures as data instead, and
 * rethrow them as defects on the calling side.
 */
export const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/**
 * How long to keep retrying a call that failed in transit: an instance being
 * reset reports an opaque error, and for a while after a deploy some instances
 * still run the previous code (whose classes don't implement our methods).
 * Backs off from 100ms to 2s, about a minute in total, so a call survives a
 * deploy's rollout.
 */
export const TRANSIT_RETRY = {
  // Whichever delay is shorter: exponential at first, then every 2 seconds.
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Call an object. A call that fails in transit is retried: use it only for
 * methods that are idempotent. A defect the object
 * reported, or a call that keeps failing, is a defect for the caller.
 */
export const unwrapDefects = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry(TRANSIT_RETRY),
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/**
 * Call an object once: for a caller that retries for itself, where
 * retrying here too (as `unwrapDefects` does) would hold it for a minute.
 */
export const callOnce = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/**
 * An object's methods run later, per call, and look up the instance's state
 * then: give each one the state the instance was built with.
 */
export const bindState = (impl: ObjectImpl): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* ObjectState;
    const record = yield* impl;
    const bound: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record)) {
      bound[name] =
        typeof value === "function"
          ? (...args: ReadonlyArray<unknown>) => {
              const result = (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
              return Effect.isEffect(result)
                ? Effect.provideService(result, ObjectState, state)
                : result;
            }
          : Effect.isEffect(value)
            ? Effect.provideService(value, ObjectState, state)
            : value;
    }
    return bound;
  });

/** An object's name in a host that keeps several classes in one of its own: `<class>/<key>`. */
export const objectName = (className: string, key: string) => `${className}/${key}`;

/** Split a {@link objectName} back into its class and key. */
export const parseObjectName = (name: string) => {
  const slash = name.indexOf("/");
  return slash < 0 ? undefined : { className: name.slice(0, slash), key: name.slice(slash + 1) };
};
