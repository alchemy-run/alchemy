/**
 * State a session keeps beside its transcript.
 *
 * A session's transcript is what the model said and read. Its state is what
 * your code knows about the session: the phase it is in, what it has done.
 * The model never reads it. A tool writes it when the model decides
 * something, the code that holds the session reads and writes it from
 * outside, and it lasts as long as the session's storage does.
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const StateTypeId = "~alchemy/AI/State" as const;

/**
 * The state of the session being answered. A harness provides it to every
 * tool call, with what it stores already narrowed to that call's session.
 * `AI.State` reads and writes through it.
 */
export class StateStore extends Context.Service<
  StateStore,
  {
    /** The stored value of the state named `name`, as JSON. */
    readonly get: (name: string) => Effect.Effect<string | undefined, never, RuntimeContext>;
    readonly put: (name: string, value: string) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * Store `next` if the stored value is still `expected`, and say whether
     * it was. A change is made from the value it read, or tried again.
     */
    readonly swap: (
      name: string,
      expected: string | undefined,
      next: string,
    ) => Effect.Effect<boolean, never, RuntimeContext>;
  }
>()("AI.StateStore") {}

/** Small values kept beside a harness's sessions: where their state is stored. */
export interface StateValues {
  readonly get: (key: string) => Effect.Effect<string | undefined, unknown, RuntimeContext>;
  readonly put: (key: string, value: string) => Effect.Effect<void, unknown, RuntimeContext>;
}

/** One lock per stored value, for as long as the instance that owns the storage lives. */
const locks = new WeakMap<object, Map<string, Semaphore.Semaphore>>();

/**
 * The state of the session `id`, kept in a harness's values. A harness
 * provides it (as `AI.StateStore`) to each tool call of that session.
 *
 * @internal
 */
export const stateStoreOf = (values: StateValues, id: string): StateStore["Service"] => {
  const key = (name: string) => `state:${id}:${name}`;
  /** One writer at a time to each stored value, so a swap compares and stores as one step. */
  const alone = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => {
    let held = locks.get(values);
    if (held === undefined) locks.set(values, (held = new Map()));
    let lock = held.get(key(name));
    if (lock === undefined) held.set(key(name), (lock = Semaphore.makeUnsafe(1)));
    return lock.withPermits(1)(effect);
  };
  const get = (name: string) => Effect.orDie(values.get(key(name)));
  const put = (name: string, value: string) => Effect.orDie(values.put(key(name), value));
  return {
    get,
    put: (name, value) => alone(name, put(name, value)),
    swap: (name, expected, next) =>
      alone(
        name,
        Effect.flatMap(get(name), (stored) =>
          stored === expected ? Effect.as(put(name, next), true) : Effect.succeed(false),
        ),
      ),
  };
};

/** What a state declares: the shape of its value, and what a new session starts with. */
export interface StateSpec<S extends Schema.Top> {
  /** The value's schema. It is stored as the JSON this schema encodes to. */
  readonly schema: S;
  /** What a session that never wrote the state has. */
  readonly initial: S["Type"];
}

/** One session's value of a state: read it, replace it, or change it. */
export interface StateOf<A, E = never, R = never> {
  /** The session's value, or `initial` when it never wrote one. */
  readonly get: Effect.Effect<A, E, R | RuntimeContext>;
  /** Replace the value. */
  readonly set: (value: A) => Effect.Effect<void, E, R | RuntimeContext>;
  /**
   * Change the value from what it is now, and give the new one. Two changes
   * to one session's value never interleave.
   */
  readonly update: (change: (value: A) => A) => Effect.Effect<A, E, R | RuntimeContext>;
}

/**
 * A declared state. Inside a tool call it is the value of the session whose
 * model made the call; outside one, name the session:
 * `engineer.get(taskId).state(Phase)`.
 */
export interface StateClass<Name extends string, S extends Schema.Top> extends StateOf<
  S["Type"],
  never,
  StateStore
> {
  new (_: never): { readonly "~state": Name };
  readonly [StateTypeId]: true;
  readonly stateName: Name;
  readonly spec: StateSpec<S>;
  /**
   * The same state over a store that is given: how a harness, or the code
   * that holds a session, reaches one session's value.
   *
   * @internal
   */
  readonly in: (store: StateStore["Service"]) => StateOf<S["Type"]>;
}

/** Any declared state. */
export type AnyState = StateClass<string, any>;

export const isState = (u: unknown): u is AnyState =>
  (typeof u === "object" || typeof u === "function") && u !== null && StateTypeId in u;

/**
 * Declare a piece of state every session keeps: typed, stored beside the
 * session's transcript, and never shown to the model.
 *
 * **Example:** The phase a session is in
 * ```typescript
 * // src/Phase.state.ts
 * export class Phase extends AI.State("phase", {
 *   schema: Schema.Struct({ phase: Schema.Literals(["research", "draft", "publish"]) }),
 *   initial: { phase: "research" },
 * }) {}
 * ```
 *
 * **Example:** A tool moves the session to its next phase
 * ```typescript
 * // src/Advance.tool.ts
 * export class Advance extends AI.Tool<Advance>()("advance", {
 *   description: "Say the research is done and drafting can start.",
 *   parameters: Schema.Struct({}),
 *   success: Schema.Void,
 * }) {}
 *
 * export const AdvanceLive = Advance.make(
 *   Effect.fn(function* () {
 *     // The state of the session whose model made this call.
 *     yield* Phase.set({ phase: "draft" });
 *   }),
 * );
 * ```
 *
 * **Example:** A tool that only works in one phase
 * ```typescript
 * // src/Publish.tool.ts
 * export const PublishLive = Publish.make(
 *   Effect.fn(function* ({ title }) {
 *     const { phase } = yield* Phase.get;
 *     if (phase !== "publish") return yield* new NotReady({ phase });
 *     return { url: `https://example.com/${title}` };
 *   }),
 * );
 * ```
 *
 * **Example:** Reading and writing a session's state from outside it
 * ```typescript
 * const engineer = yield* Engineer;
 * const phase = engineer.get(taskId).state(Phase);
 *
 * const { phase: now } = yield* phase.get;
 * yield* phase.update((state) => ({ ...state, phase: "publish" }));
 * ```
 */
export const State = <const Name extends string, S extends Schema.Top>(
  name: Name,
  spec: StateSpec<S>,
): StateClass<Name, S> => {
  type A = S["Type"];
  // Stored as the JSON the schema encodes to.
  const json = spec.schema.pipe(
    Schema.toCodecJson,
    Schema.fromJsonString,
  ) as unknown as Schema.Codec<A, string>;
  const decode = Schema.decodeUnknownEffect(json);
  const encode = Schema.encodeUnknownEffect(json);
  // A value that no longer decodes (its schema changed) is a defect: there is nothing the caller can do.
  const valueOf = (stored: string | undefined) =>
    stored === undefined ? Effect.succeed(spec.initial as A) : Effect.orDie(decode(stored));
  const over = (store: StateStore["Service"]): StateOf<A> => {
    const update = (change: (value: A) => A): Effect.Effect<A, never, RuntimeContext> =>
      Effect.gen(function* () {
        const stored = yield* store.get(name);
        const next = change(yield* valueOf(stored));
        const swapped = yield* store.swap(name, stored, yield* Effect.orDie(encode(next)));
        // Someone else wrote it in between: change what they wrote.
        return swapped ? next : yield* update(change);
      });
    return {
      get: Effect.flatMap(store.get(name), valueOf),
      set: (value) =>
        Effect.flatMap(Effect.orDie(encode(value)), (encoded) => store.put(name, encoded)),
      update,
    };
  };
  return class {
    static readonly [StateTypeId] = true;
    static readonly stateName = name;
    static readonly spec = spec;
    static readonly in = over;
    static readonly get = Effect.flatMap(StateStore, (store) => over(store).get);
    static readonly set = (value: A) =>
      Effect.flatMap(StateStore, (store) => over(store).set(value));
    static readonly update = (change: (value: A) => A) =>
      Effect.flatMap(StateStore, (store) => over(store).update(change));
  } as unknown as StateClass<Name, S>;
};
