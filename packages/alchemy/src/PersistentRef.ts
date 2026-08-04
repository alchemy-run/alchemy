import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { LazyArg } from "effect/Function";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SchemaModule from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/**
 * A durable, named `Ref`-shaped cell backed by a swappable `Store`
 * Layer.
 *
 * `PersistentRef.make(name, initial)` returns a small, deliberate
 * interface — `get` / `set` / `update` / `modify` — over an in-memory
 * cell that writes through to persistence. Reads are always memory
 * (no round trip); a write updates memory immediately and settles when
 * the store's write settles, so `yield* ref.set(x)` IS the durability
 * point. Writes to one ref are serialized FIFO, so an async store can
 * never persist an older value over a newer one.
 *
 * Why a named constructor and our own interface, rather than making
 * `Ref.make` itself persistent:
 *
 * - **Identity.** Refs are anonymous and positional; after a process
 *   restart / DO eviction the creating closure re-runs and makes *new*
 *   refs. Durable identity needs a stable key — the `name`.
 * - **Serializability.** A `Ref` may hold anything; a durable one must
 *   round-trip. Pass a `schema` for rich types; without one the value
 *   must survive the store's serialization (structured clone / JSON).
 * - **Effectful writes.** `effect/Ref`'s combinators are synchronous
 *   (`Effect.sync` over a mutable cell) with no seam to await a store,
 *   so implementing its interface would force sync-only stores. Owning
 *   the (four-method) interface lets `write` be an Effect and any
 *   store — DO storage, KV, D1, filesystem — implement it honestly.
 * - **Failures are defects.** Persistence can fail, but a consumer
 *   can't meaningfully handle a storage failure mid-run: the store
 *   surfaces it as a defect (crash-and-retry, at-least-once), keeping
 *   every method's error channel clean instead of threading a
 *   `StoreError` through all charter code.
 *
 * @example
 * ```ts
 * import * as PersistentRef from "alchemy/PersistentRef";
 *
 * const program = Effect.gen(function* () {
 *   const phase = yield* PersistentRef.make("phase", () => "reproduce");
 *   yield* phase.set("diagnose");          // durable once settled
 *   const now = yield* phase.get;          // in-memory read
 *   yield* phase.update((p) => p + "!");
 * });
 * // tests / local:
 * program.pipe(Effect.provide(PersistentRef.layerMemory));
 * ```
 */
export interface PersistentRef<in out A> {
  /** The current value — an in-memory read, never a store round trip. */
  readonly get: Effect.Effect<A>;
  /**
   * Replace the value. Memory updates immediately; the effect settles
   * when the store's write settles (the durability point).
   */
  readonly set: (value: A) => Effect.Effect<void>;
  /** Transform the value with `f`; same write semantics as `set`. */
  readonly update: (f: (current: A) => A) => Effect.Effect<void>;
  /**
   * Atomically compute a result and the next value from the current
   * one; returns the result once the write settles.
   */
  readonly modify: <B>(f: (current: A) => readonly [B, A]) => Effect.Effect<B>;
}

/**
 * The persistence surface a `PersistentRef` writes through. Implemented
 * per substrate and provided as a Layer: Durable Object storage, a
 * KV/D1 binding, an in-memory Map for tests — the consuming code never
 * changes. Both operations may be asynchronous; storage failures are
 * defects, never typed errors.
 */
export interface StoreService {
  /**
   * Load the persisted encoded value for `name`, or `undefined` when
   * nothing has been written.
   */
  readonly load: (name: string) => Effect.Effect<unknown>;
  /**
   * Persist an encoded value. The effect settling IS the durability
   * point — `set`/`update`/`modify` on the ref settle with it.
   */
  readonly write: (name: string, encoded: unknown) => Effect.Effect<void>;
}

export class Store extends Context.Service<Store, StoreService>()(
  "alchemy/PersistentRef/Store",
) {}

/**
 * One live ref per (store, name): re-making the same name against the
 * same store instance returns the SAME ref, so two call sites can
 * never hold diverging in-memory caches of one durable row. A new
 * store instance (a fresh activation) re-loads from storage.
 */
const instances = new WeakMap<StoreService, Map<string, PersistentRef<any>>>();

export interface MakeOptions<A, I> {
  /**
   * Schema used to encode the value for storage and decode it back on
   * load. Without one, the value is stored as-is and must survive the
   * store's serialization (structured clone / JSON). A decode failure
   * on load is a defect — persisted state that no longer matches its
   * schema should fail loudly, not limp.
   */
  readonly schema?: Schema.Codec<A, I>;
}

/**
 * Create (or resume) a durable named cell.
 *
 * - First activation: no persisted row exists, the ref starts at the
 *   `initial` value — a lazy thunk, or an Effect that is run ONLY in
 *   this case (the "load once per instance" pattern: fetch it on
 *   first contact, never again). The default itself is NOT persisted
 *   until written — an untouched name has no row.
 * - Re-activation: the persisted value is loaded and decoded; the ref
 *   resumes where it left off. An Effect `initial` does not run.
 * - Same store instance, same name: returns the memoized ref (name is
 *   identity — do not reuse one name at two different types).
 *
 * Note: a function `initial` is always treated as a lazy thunk — a
 * function is not a legal persisted value anyway (it can't
 * round-trip).
 */
export const make = <A, I = A, E = never, R = never>(
  name: string,
  initial: LazyArg<A> | Effect.Effect<A, E, R>,
  options?: MakeOptions<A, I>,
): Effect.Effect<PersistentRef<A>, E, Store | R> =>
  Effect.gen(function* () {
    const store = yield* Store;
    let refs = instances.get(store);
    if (refs === undefined) {
      refs = new Map();
      instances.set(store, refs);
    }
    const existing = refs.get(name);
    if (existing !== undefined) return existing as PersistentRef<A>;

    const schema = options?.schema;
    const decode = schema
      ? SchemaModule.decodeUnknownSync(schema)
      : (u: unknown) => u as A;
    const encode = schema
      ? SchemaModule.encodeSync(schema)
      : (a: A) => a as unknown;

    const loaded = yield* store.load(name);
    let current =
      loaded === undefined
        ? Effect.isEffect(initial)
          ? yield* initial as Effect.Effect<A, E, R>
          : initial()
        : decode(loaded);

    // Writes are serialized FIFO per ref: memory is updated at call
    // order, and the mutex hands the store the same order, so a slow
    // async write can never land after (and clobber) a newer one.
    const writes = Semaphore.makeUnsafe(1);
    const persist = (value: A) =>
      writes.withPermits(1)(store.write(name, encode(value)));

    const ref: PersistentRef<A> = {
      get: Effect.sync(() => current),
      set: (value) =>
        Effect.suspend(() => {
          current = value;
          return persist(value);
        }),
      update: (f) =>
        Effect.suspend(() => {
          current = f(current);
          return persist(current);
        }),
      modify: (f) =>
        Effect.suspend(() => {
          const [result, next] = f(current);
          current = next;
          return Effect.as(persist(next), result);
        }),
    };

    refs.set(name, ref);
    return ref;
  });

/**
 * An in-memory store: durability equals the Layer's lifetime. The
 * right store for tests and for substrates whose process lifetime IS
 * the run lifetime (e.g. the in-memory AI kernel).
 */
export const layerMemory: Layer.Layer<Store> = Layer.sync(Store, () =>
  makeMemoryStore(),
);

/**
 * Build a memory `StoreService` over an explicit map — useful when
 * the caller owns the map's lifetime (a per-run record) or when a
 * test needs to simulate re-activation by building two stores over
 * one map.
 */
export const makeMemoryStore = (
  map: Map<string, unknown> = new Map(),
): StoreService => ({
  load: (name) => Effect.sync(() => map.get(name)),
  write: (name, encoded) => Effect.sync(() => void map.set(name, encoded)),
});
