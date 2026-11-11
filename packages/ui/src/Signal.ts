/**
 * Reactive values. A `Signal.State` is a named value a component owns and
 * changes from its Intents; a `Signal.Computed` derives from other signals and
 * recomputes only when they change. The view binds signals directly, so a
 * write updates exactly the DOM nodes that read it.
 *
 * ```typescript
 * const clicks = yield* Signal.state("clicks", 0);
 * const label = Signal.map(clicks, (n) => `Clicked ${n} times`);
 * ```
 */
import * as Effect from "effect/Effect";
import { ComputedNode, StateNode, type Source } from "./internal/graph.ts";
import { type Declares, Handler, Setup, type StateDecl } from "./internal/instance.ts";

export const TypeId = "~@alchemy.run/ui/Signal";

/** A value that can change. Bind it in a view, or read it in a handler with `Signal.get`. */
export interface Signal<out A> {
  readonly [TypeId]: Source<A>;
}

/** A signal the component owns and writes from its Intents. */
export interface State<in out A> extends Signal<A> {
  readonly name: string;
  /** The current value. */
  readonly get: Effect.Effect<A>;
  /** Replaces the value. Only an Intent's handler can write. */
  readonly set: (value: A) => Effect.Effect<void, never, Handler>;
  /** Replaces the value with `f` of the current one, and returns the new value. */
  readonly update: (f: (value: A) => A) => Effect.Effect<A, never, Handler>;
}

/** A signal derived from other signals. */
export interface Computed<out A> extends Signal<A> {}

export const isSignal = (u: unknown): u is Signal<unknown> =>
  typeof u === "object" && u !== null && TypeId in u;

/** @internal */
export const sourceOf = <A>(signal: Signal<A>): Source<A> => signal[TypeId];

/**
 * Declares a piece of state named `name`. The name identifies it in stories
 * and the log, and is part of the component's inferred model.
 */
export const state = <const N extends string, A>(
  name: N,
  initial: A,
): Effect.Effect<State<A>, never, Setup | Declares<StateDecl<N, A>>> =>
  Effect.gen(function* () {
    const instance = yield* Setup;
    const node = new StateNode(initial);
    yield* instance.register("state", name, node as StateNode<unknown>);
    const write = (next: A): void => {
      const before = node.read();
      if (node.write(next)) instance.recordWrite(name, before, next);
    };
    const signal: State<A> = {
      [TypeId]: node,
      name,
      get: Effect.sync(node.read),
      set: (value) => Effect.sync(() => write(value)),
      update: (f) =>
        Effect.sync(() => {
          write(f(node.read()));
          return node.read();
        }),
    };
    return signal;
  }) as Effect.Effect<State<A>, never, Setup | Declares<StateDecl<N, A>>>;

/** Derives a signal from one other signal. */
export const map = <A, B>(signal: Signal<A>, f: (a: A) => B): Computed<B> => ({
  [TypeId]: new ComputedNode([sourceOf(signal)], (values) => f(values[0] as A)),
});

/** Combines several signals into one signal of a tuple. */
export const all = <const Signals extends ReadonlyArray<Signal<any>>>(
  signals: Signals,
): Computed<{
  -readonly [K in keyof Signals]: Signals[K] extends Signal<infer A> ? A : never;
}> => ({
  [TypeId]: new ComputedNode(signals.map(sourceOf), (values) => values as never),
});

/** Reads a signal's current value, for use in a handler. */
export const get = <A>(signal: Signal<A>): Effect.Effect<A> =>
  Effect.sync(() => sourceOf(signal).read());
