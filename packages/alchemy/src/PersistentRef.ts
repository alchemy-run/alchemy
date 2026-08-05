import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type { LazyArg } from "effect/Function";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SchemaModule from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** Internal write surface — reach it through the module functions. */
const Ops = "~alchemy/PersistentRef" as const;
type Ops = typeof Ops;

/**
 * A durable, named `Ref`-shaped cell backed by a swappable `Store`
 * Layer.
 *
 * A `PersistentRef<A>` IS an `Effect<A>` — yielding it reads the
 * current value (always memory, never a store round trip). Writes go
 * through the module functions, mirroring `effect/Ref`'s surface:
 *
 * - `PersistentRef.set(ref, value)`
 * - `PersistentRef.update(ref, f)`
 * - `PersistentRef.modify(ref, f)` — compute a result and the next
 *   value in one step
 *
 * A write updates memory immediately and settles when the store's
 * write settles, so `yield* PersistentRef.set(ref, x)` IS the
 * durability point. Writes to one ref are serialized FIFO, so an
 * async store can never persist an older value over a newer one.
 *
 * ## Namespacing
 *
 * A ref's identity is a PATH — the ambient chain of namespace
 * segments plus its `name`. The chain is private to this module; the
 * two ways onto it:
 *
 * - **Hosts** (the AI kernels) frame every run automatically:
 *   `["IssueOwner", "sam-goodwin/test-alchemy#123"]`. Charter code
 *   gets per-instance isolation without ever naming itself.
 * - **Libraries** scope their own state with {@link within}:
 *   `within("coding")(effect)` — their `"progress"` can never collide
 *   with the charter's.
 *
 * Segments are arbitrary strings — `/`, `#`, anything. Identity is
 * the segment TUPLE, never a joined string; mapping the tuple onto a
 * flat keyspace is the store's job (see {@link pathKey} for the
 * canonical encoding stores may share).
 *
 * ## Why a named constructor and our own type
 *
 * - **Identity.** Refs are anonymous and positional; after a process
 *   restart / DO eviction the creating closure re-runs and makes *new*
 *   refs. Durable identity needs a stable key — the name + chain.
 * - **Serializability.** A `Ref` may hold anything; a durable one must
 *   round-trip. Pass a `schema` for rich types; without one the value
 *   must survive the store's serialization (structured clone / JSON).
 * - **Effectful writes.** `effect/Ref`'s combinators are synchronous
 *   (`Effect.sync` over a mutable cell) with no seam to await a store,
 *   so implementing its interface would force sync-only stores. Owning
 *   the type lets `write` be an Effect and any store — DO storage, KV,
 *   D1, filesystem — implement it honestly.
 * - **Failures are defects.** Persistence can fail, but a consumer
 *   can't meaningfully handle a storage failure mid-run: the store
 *   surfaces it as a defect (crash-and-retry, at-least-once), keeping
 *   every operation's error channel clean instead of threading a
 *   `StoreError` through all charter code.
 *
 * @example
 * ```ts
 * import * as PersistentRef from "alchemy/PersistentRef";
 *
 * const program = Effect.gen(function* () {
 *   const phase = yield* PersistentRef.make("phase", () => "reproduce");
 *   yield* PersistentRef.set(phase, "diagnose"); // durable once settled
 *   const now = yield* phase;                    // in-memory read
 *   yield* PersistentRef.update(phase, (p) => p + "!");
 * });
 * // tests / local:
 * program.pipe(Effect.provide(PersistentRef.layerMemory));
 * ```
 */
export interface PersistentRef<in out A> extends Effect.Effect<A> {
  readonly [Ops]: {
    readonly set: (value: A) => Effect.Effect<void>;
    readonly modify: <B>(
      f: (current: A) => readonly [B, A],
    ) => Effect.Effect<B>;
  };
}

/** Read the current value — identical to yielding the ref itself. */
export const get = <A>(ref: PersistentRef<A>): Effect.Effect<A> => ref;

/**
 * Replace the value. Memory updates immediately; the effect settles
 * when the store's write settles (the durability point).
 */
export const set = <A>(ref: PersistentRef<A>, value: A): Effect.Effect<void> =>
  ref[Ops].set(value);

/** Transform the value with `f`; same write semantics as `set`. */
export const update = <A>(
  ref: PersistentRef<A>,
  f: (current: A) => A,
): Effect.Effect<void> => ref[Ops].modify((current) => [undefined, f(current)]);

/**
 * Atomically compute a result and the next value from the current
 * one; returns the result once the write settles.
 */
export const modify = <A, B>(
  ref: PersistentRef<A>,
  f: (current: A) => readonly [B, A],
): Effect.Effect<B> => ref[Ops].modify(f);

// ---------------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------------

/**
 * The ambient namespace chain — PRIVATE to this module. Nobody can
 * name the tag from outside; the only doors onto the chain are
 * {@link within} and the hosts' own framing (which uses `within`).
 */
const Chain = Context.Reference<ReadonlyArray<string>>(
  "alchemy/PersistentRef/Chain",
  { defaultValue: () => [] },
);

/**
 * Scope every `PersistentRef.make` inside `effect` under additional
 * namespace segments. Nests: chains extend, never replace.
 *
 * - Library code isolates its private state:
 *   `myHelpers.pipe(PersistentRef.within("coding"))` — its
 *   `"progress"` and the charter's `"progress"` are different rows.
 * - Hosts (the AI kernels) frame each run with its durable identity
 *   (`within(agent, runKey)`), which is why the same charter's
 *   `make("phase")` is isolated per instance on any store — including
 *   shared ones. Segments are arbitrary strings; run keys with `/`
 *   need no escaping.
 */
export const within =
  (...segments: ReadonlyArray<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Chain, (chain) =>
      Effect.provideService(effect, Chain, [...chain, ...segments]),
    );

/** A ref's full identity: the ambient chain plus its name. */
export type StoreKey = ReadonlyArray<string>;

/**
 * The canonical mapping from a {@link StoreKey} to a single flat
 * string, for stores whose underlying keyspace is one-dimensional
 * (KV, DO storage, a filename). Each segment is escaped (`%` →
 * `%25`, `/` → `%2F`) and joined with `/`, so distinct tuples always
 * map to distinct strings AND keys read as paths:
 *
 * `["Engineer", "o/r#123", "phase"]` → `"Engineer/o%2Fr#123/phase"`
 *
 * Stores are free to use their own mapping instead (a hierarchical
 * store might keep the tuple as columns).
 */
export const pathKey = (key: StoreKey): string =>
  key
    .map((segment) => segment.replaceAll("%", "%25").replaceAll("/", "%2F"))
    .join("/");

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The persistence surface a `PersistentRef` writes through. Implemented
 * per substrate and provided as a Layer: Durable Object storage, a
 * KV/D1 binding, an in-memory Map for tests — the consuming code never
 * changes. Both operations may be asynchronous; storage failures are
 * defects, never typed errors.
 *
 * Keys are segment TUPLES ({@link StoreKey}); how a tuple maps onto
 * the underlying keyspace is the store's decision ({@link pathKey} is
 * the canonical flat encoding).
 */
export interface StoreService {
  /**
   * Load the persisted encoded value for `key`, or `undefined` when
   * nothing has been written.
   */
  readonly load: (key: StoreKey) => Effect.Effect<unknown>;
  /**
   * Persist an encoded value. The effect settling IS the durability
   * point — `set`/`update`/`modify` on the ref settle with it.
   */
  readonly write: (key: StoreKey, encoded: unknown) => Effect.Effect<void>;
}

export class Store extends Context.Service<Store, StoreService>()(
  "alchemy/PersistentRef/Store",
) {}

/**
 * One live ref per (store, full key): re-making the same name in the
 * same namespace against the same store instance returns the SAME
 * ref, so two call sites can never hold diverging in-memory caches of
 * one durable row. A different namespace = a different ref. A new
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
 * Create (or resume) a durable named cell. Its identity is the
 * ambient namespace chain (see {@link within}) plus `name`.
 *
 * - First activation: no persisted row exists, the ref starts at the
 *   `initial` value — a lazy thunk, or an Effect that is run ONLY in
 *   this case (the "load once per instance" pattern: fetch it on
 *   first contact, never again). The default itself is NOT persisted
 *   until written — an untouched name has no row.
 * - Re-activation: the persisted value is loaded and decoded; the ref
 *   resumes where it left off. An Effect `initial` does not run.
 * - Same store instance, same identity: returns the memoized ref (do
 *   not reuse one name at two different types).
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
    const chain = yield* Chain;
    const key: StoreKey = [...chain, name];

    let refs = instances.get(store);
    if (refs === undefined) {
      refs = new Map();
      instances.set(store, refs);
    }
    // JSON is the internal memo encoding — collision-free over tuples
    // regardless of what characters segments contain.
    const memoKey = JSON.stringify(key);
    const existing = refs.get(memoKey);
    if (existing !== undefined) return existing as PersistentRef<A>;

    const schema = options?.schema;
    const decode = schema
      ? SchemaModule.decodeUnknownSync(schema)
      : (u: unknown) => u as A;
    const encode = schema
      ? SchemaModule.encodeSync(schema)
      : (a: A) => a as unknown;

    const loaded = yield* store.load(key);
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
      writes.withPermits(1)(store.write(key, encode(value)));

    const read = Effect.sync(() => current);
    const ref = Object.assign(
      Object.create(
        // Yielding the ref IS the read — a PersistentRef is an Effect.
        Effectable.Prototype({
          label: "alchemy/PersistentRef",
          evaluate: () => read,
        }),
      ),
      {
        [Ops]: {
          set: (value: A) =>
            Effect.suspend(() => {
              current = value;
              return persist(value);
            }),
          modify: <B>(f: (current: A) => readonly [B, A]) =>
            Effect.suspend(() => {
              const [result, next] = f(current);
              current = next;
              return Effect.as(persist(next), result);
            }),
        },
      },
    ) as PersistentRef<A>;

    refs.set(memoKey, ref);
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
 * one map. Rows are keyed by {@link pathKey}.
 */
export const makeMemoryStore = (
  map: Map<string, unknown> = new Map(),
): StoreService => ({
  load: (key) => Effect.sync(() => map.get(pathKey(key))),
  write: (key, encoded) =>
    Effect.sync(() => void map.set(pathKey(key), encoded)),
});
