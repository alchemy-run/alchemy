import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { type InputGateShape, makeInputGate } from "alchemy/Workers/InputGate";
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

// ---------------------------------------------------------------- an in-process Durable Object host

/** Rows the objects of one host read from storage. */
export interface Stats {
  rowsRead: number;
  /** When set, counts what each put writes: the key's and the value's JSON length. */
  bytesWritten?: number;
}

/** Answers true for a key a put should fail to write, as a storage error would. */
export type FailPut = (key: string) => boolean;

/** Sorted key-value storage that counts the rows it reads, as Durable Object billing does. */
const makeStorage = (
  stats: Stats,
  data: Map<string, unknown>,
  failPut?: FailPut,
): DurableObjects.ObjectStorage => {
  const sortedKeys = () => [...data.keys()].sort();
  const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
  const write = (key: string, value: unknown) => {
    if (failPut?.(key)) throw new Error(`injected: writing ${key} failed`);
    if (stats.bytesWritten !== undefined) {
      stats.bytesWritten += key.length + (value === undefined ? 0 : JSON.stringify(value).length);
    }
    data.set(key, clone(value));
  };
  const storage: DurableObjects.ObjectStorage = {
    get: <T>(key: string) =>
      Effect.sync(() => {
        stats.rowsRead += 1;
        return clone(data.get(key) as T | undefined);
      }),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        if (typeof keyOrEntries === "string") write(keyOrEntries, value);
        // Cloudflare's storage takes at most 128 keys a put.
        else if (Object.keys(keyOrEntries).length > 128) throw new Error("more than 128 keys");
        else for (const [key, entry] of Object.entries(keyOrEntries)) write(key, entry);
      })) as DurableObjects.ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
      Effect.sync(() => {
        if (typeof keyOrKeys === "string") return data.delete(keyOrKeys);
        return keyOrKeys.filter((key) => data.delete(key)).length;
      })) as DurableObjects.ObjectStorage["delete"],
    list: <T>(options: DurableObjects.ListOptions = {}) =>
      Effect.sync(() => {
        let keys = sortedKeys().filter(
          (key) =>
            (options.prefix === undefined || key.startsWith(options.prefix)) &&
            (options.start === undefined || key >= options.start) &&
            (options.startAfter === undefined || key > options.startAfter) &&
            (options.end === undefined || key < options.end),
        );
        if (options.reverse) keys.reverse();
        if (options.limit !== undefined) keys = keys.slice(0, options.limit);
        stats.rowsRead += keys.length;
        return new Map(keys.map((key) => [key, clone(data.get(key) as T)]));
      }),
    // Writes inside commit together: a failure restores what was there before.
    transaction: (effect) =>
      Effect.suspend(() => {
        const before = new Map(data);
        return effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => {
                  data.clear();
                  for (const [key, value] of before) data.set(key, value);
                })
              : Effect.void,
          ),
        );
      }),
  };
  return storage;
};

/** What survives an object being evicted: its storage and its alarm. */
export interface Disk {
  readonly objects: Map<
    string,
    { readonly data: Map<string, unknown>; alarm: number | undefined; cls: string; name: string }
  >;
}

/** Wrap a call between objects: the test decides how long it takes, or whether it fails. */
export type Intercept = (
  call: { readonly cls: string; readonly method: string; readonly args: ReadonlyArray<unknown> },
  run: Effect.Effect<unknown, unknown>,
) => Effect.Effect<unknown, unknown>;

/**
 * Objects run in this process: one instance per name, built on its first
 * call, with storage that counts rows read and one alarm for its callbacks.
 * Calls cross a JSON boundary, as Workers RPC does.
 */
/**
 * Storage behind an instance's input gate, as Rivet's bridge runs it: each
 * operation waits for its call's turn, and a transaction holds the gate.
 */
const gatedStorage = (
  storage: DurableObjects.ObjectStorage,
  gate: InputGateShape,
): DurableObjects.ObjectStorage => ({
  get: (key) => gate.storage(storage.get(key)),
  put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
    gate.storage(
      typeof keyOrEntries === "string"
        ? storage.put(keyOrEntries, value)
        : storage.put(keyOrEntries),
    )) as DurableObjects.ObjectStorage["put"],
  delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
    typeof keyOrKeys === "string"
      ? gate.storage(storage.delete(keyOrKeys))
      : gate.storage(storage.delete(keyOrKeys))) as DurableObjects.ObjectStorage["delete"],
  list: (options) => gate.storage(storage.list(options)),
  transaction: (effect) => gate.exclusive(storage.transaction(effect)),
});

export const simHost = (
  stats: Stats,
  options: {
    readonly disk?: Disk;
    readonly intercept?: Intercept;
    /** Give each instance Rivet's input gate: construction and each call are calls of their own. */
    readonly inputGate?: boolean;
    /** Fail the puts it answers true for, inside or outside a transaction. */
    readonly failPut?: FailPut;
  } = {},
) => {
  const disk = options.disk ?? { objects: new Map() };
  const classes = new Map<string, DurableObjects.ObjectImpl>();
  const instances = new Map<string, Effect.Effect<Record<string, unknown>>>();
  const scopes = new Map<string, Scope.Closeable>();
  const instance = (cls: string, name: string) => {
    const id = `${cls}/${name}`;
    let built = instances.get(id);
    if (built === undefined) {
      const saved = disk.objects.get(id) ?? { data: new Map(), alarm: undefined, cls, name };
      disk.objects.set(id, saved);
      const inputGate = options.inputGate ? Effect.runSync(makeInputGate) : undefined;
      const asCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        inputGate === undefined ? effect : inputGate.call(effect);
      const stored = makeStorage(stats, saved.data, options.failPut);
      const storage = inputGate === undefined ? stored : gatedStorage(stored, inputGate);
      const gate = Semaphore.makeUnsafe(1);
      const scope = Scope.makeUnsafe();
      scopes.set(id, scope);
      const services = Effect.gen(function* () {
        let timer: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined;
        const set = (at: number) =>
          Effect.gen(function* () {
            const previous = timer;
            const now = yield* Clock.currentTimeMillis;
            const fiber = yield* Effect.sleep(Math.max(0, at - now)).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  timer = undefined;
                  // Like Cloudflare's, the alarm stays until its handler returns: an object
                  // evicted while it runs gets it again.
                  return callbacks.fire.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (saved.alarm === at) saved.alarm = undefined;
                      }),
                    ),
                  );
                }),
              ),
              Effect.forkIn(scope),
            );
            timer = { at, fiber };
            saved.alarm = at;
            if (previous) yield* Fiber.interrupt(previous.fiber);
          });
        const callbacks = storageCallbacks(storage, {
          get: Effect.sync(() => timer?.at ?? null),
          set,
        });
        // An alarm set before the object was evicted still fires.
        if (saved.alarm !== undefined) yield* set(saved.alarm);
        return {
          state: {
            storage,
            exclusive: (effect) => gate.withPermits(1)(effect),
            waitUntil: (effect) => Effect.asVoid(Effect.forkIn(effect, scope)),
          } satisfies DurableObjects.ObjectStateShape,
          runtime: {
            Type: "Sim",
            id,
            env: {},
            get: () => Effect.undefined,
            set: (key: string) => Effect.succeed(key),
          } as RuntimeContext["Service"],
          callbacks: callbacks.callbacks,
        };
      });
      built = Effect.gen(function* () {
        const { state, runtime, callbacks } = yield* services;
        const record = yield* classes
          .get(cls)!
          .pipe(
            asCall,
            Effect.provideService(DurableObjects.ObjectState, state),
            Effect.provideService(RuntimeContext, runtime),
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(callbacks),
          );
        // Each call runs as its own event, with the instance's runtime.
        const methods: Record<string, unknown> = {};
        for (const [method, value] of Object.entries(record)) {
          methods[method] =
            typeof value === "function"
              ? (...args: ReadonlyArray<unknown>) => {
                  const result = (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
                  return Effect.isEffect(result)
                    ? Effect.scoped(
                        (result as Effect.Effect<unknown, unknown, RuntimeContext>).pipe(
                          asCall,
                          Effect.provideService(RuntimeContext, runtime),
                        ),
                      )
                    : result;
                }
              : value;
        }
        return methods;
      }).pipe(Effect.cached, Effect.runSync);
      instances.set(id, built);
    }
    return built;
  };
  const namespace = (cls: string): DurableObjects.Namespace => ({
    getByName: (name) =>
      new Proxy({} as DurableObjects.Stub, {
        get:
          (_, method: string) =>
          (...args: ReadonlyArray<unknown>) => {
            const run = Effect.flatMap(instance(cls, name), (methods) => {
              const call = methods[method] as (
                ...args: ReadonlyArray<unknown>
              ) => Effect.Effect<unknown, unknown>;
              return call(...structuredClone(args)).pipe(
                Effect.map((result) => (result === undefined ? result : structuredClone(result))),
              );
            });
            return options.intercept === undefined
              ? run
              : options.intercept({ cls, method, args }, run);
          },
      }),
  });
  /**
   * Evict every object: what it held in memory is gone, and its storage and
   * alarm stay. An object with an alarm runs again when the alarm is due.
   */
  const wake = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const saved of disk.objects.values()) {
      if (saved.alarm === undefined) continue;
      const { cls, name } = saved;
      yield* Effect.sleep(Math.max(0, saved.alarm - now)).pipe(
        Effect.andThen(Effect.suspend(() => instance(cls, name))),
        Effect.forkDetach,
      );
    }
  });
  const evict = Effect.gen(function* () {
    for (const scope of scopes.values()) yield* Scope.close(scope, Exit.void);
    scopes.clear();
    instances.clear();
    yield* wake;
  });
  /** Call a method of one object directly, as another object would: JSON in, JSON out. */
  const call = (cls: string, name: string, method: string, ...args: ReadonlyArray<unknown>) =>
    (
      namespace(cls).getByName(name) as unknown as Record<
        string,
        (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
      >
    )[method]!(...args);
  const host: DurableObjects.Host = {
    declare: (model, cls, impl) =>
      Effect.sync(() => {
        const name = DurableObjects.className(model.modelName, cls);
        classes.set(name, impl);
        return namespace(name);
      }),
    lookup: (model, cls) => namespace(DurableObjects.className(model.modelName, cls)),
    claimKey: Effect.sync(() => ({})),
  };
  return { host, evict, wake, disk, call };
};
