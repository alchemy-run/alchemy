// Every function the prover has a model for, called in ways a handler should
// not call it: with nothing, with too little, with the wrong kinds of values,
// and with a value of its own module first and the wrong things after. What
// a call gives is run when it is an effect. Each call is reported, or read as
// the real code runs it.

import { surface } from "@alchemy.run/domain/Prove/Surface";
import type { Group } from "./cases.ts";

/** The arguments each function is called with, written in the inputs `a` and `b`. */
const SHAPES: ReadonlyArray<string> = [``, `a`, `"x", a`, `a, b, a`, `{}, a`, `[a], () => b`];

/** What follows a value of the function's own module: the wrong things, and too many of them. */
const AFTER: ReadonlyArray<string> = [``, `"x"`, `a, b`, `{}`, `() => b`, `[a]`, `undefined`];

/** A value of a module's own kind, made in a handler: `self` in the calls of its functions. */
const SELF: Readonly<Record<string, string | ReadonlyArray<string>>> = {
  Combiner: `Combiner.make((x, y) => x + y)`,
  Data: `Data.struct({ x: a })`,
  Equal: `a`,
  Equivalence: `Equivalence.Number`,
  Filter: `Filter.fromPredicate((n) => n > b)`,
  Function: `(n) => n + a`,
  Hash: `a`,
  Ordering: `-1`,
  Pool: `yield* Pool.make({ acquire: Effect.succeed(a), size: 1 })`,
  Predicate: `(n) => n > b`,
  RcMap: `yield* RcMap.make({ lookup: (key) => Effect.succeed(key) })`,
  RcRef: `yield* RcRef.make({ acquire: Effect.succeed(a) })`,
  Redacted: `Redacted.make(a)`,
  Reducer: `Reducer.make((x, y) => x + y, 0)`,
  Request: `Request.tagged("Asked")({ n: a })`,
  RequestResolver: `RequestResolver.fromEffect((entry) => Effect.succeed(entry.request.n))`,
  Resource: `yield* Resource.manual(Effect.succeed(a))`,
  ScopedRef: `yield* ScopedRef.make(() => a)`,
  SynchronizedRef: `yield* SynchronizedRef.make(a)`,
  Array: [`[a, b]`, `[]`],
  BigDecimal: `BigDecimal.fromBigInt(1n)`,
  BigInt: `1n`,
  Boolean: `a > b`,
  Cache: `yield* Cache.make({ capacity: 2, lookup: (key) => Effect.succeed(key) })`,
  Cause: [`Cause.fail(a)`, `Cause.die(a)`],
  Channel: [`Channel.succeed(a)`, `Channel.fail(a)`],
  Chunk: [`Chunk.make(a, b)`, `Chunk.empty()`],
  Context: `Context.empty()`,
  DateTime: `DateTime.makeUnsafe(0)`,
  Deferred: `yield* Deferred.make()`,
  Duration: `Duration.millis(a)`,
  Effect: [`Effect.succeed(a)`, `Effect.fail(a)`],
  Exit: [`Exit.succeed(a)`, `Exit.fail(a)`],
  Fiber: `yield* Effect.forkChild(Effect.succeed(a))`,
  FiberHandle: `yield* FiberHandle.make()`,
  FiberMap: `yield* FiberMap.make()`,
  FiberSet: `yield* FiberSet.make()`,
  HashMap: `HashMap.make(["k", a])`,
  HashSet: `HashSet.make(a, b)`,
  Iterable: `[a, b]`,
  Latch: `yield* Latch.make()`,
  Layer: `Layer.empty`,
  Match: `Match.value(a)`,
  Metric: `Metric.counter("c")`,
  MutableHashMap: `MutableHashMap.empty()`,
  MutableHashSet: `MutableHashSet.empty()`,
  MutableList: `MutableList.make(a, b)`,
  MutableRef: `MutableRef.make(a)`,
  Number: `a`,
  Optic: `Optic.id()`,
  Option: [`Option.some(a)`, `Option.none()`],
  Order: `Order.Number`,
  PartitionedSemaphore: `yield* PartitionedSemaphore.make({ permits: 1 })`,
  PubSub: `yield* PubSub.unbounded()`,
  Queue: `yield* Queue.unbounded()`,
  Rational: `Rational.fromBigInt(1n)`,
  Record: `{ x: a }`,
  Ref: `yield* Ref.make(a)`,
  Result: [`Result.succeed(a)`, `Result.fail(a)`],
  Schedule: [`Schedule.recurs(1)`, `Schedule.spaced("1 millis")`],
  Scope: `yield* Scope.make()`,
  ScopedCache: `yield* ScopedCache.make({ capacity: 2, lookup: (key) => Effect.succeed(key) })`,
  Semaphore: `yield* Semaphore.make(1)`,
  Sink: [`Sink.count`, `Sink.take(1)`],
  Stream: [`Stream.make(a, b)`, `Stream.fromEffect(Effect.succeed(a))`, `Stream.fail(a)`],
  String: [`"ab"`, `""`],
  Struct: `{ x: a }`,
  SubscriptionRef: `yield* SubscriptionRef.make(a)`,
  Tuple: `[a, b]`,
  TxChunk: `yield* TxChunk.empty()`,
  TxDeferred: `yield* TxDeferred.make()`,
  TxHashMap: `yield* TxHashMap.empty()`,
  TxHashSet: `yield* TxHashSet.empty()`,
  TxPriorityQueue: `yield* TxPriorityQueue.empty(Order.Number)`,
  TxPubSub: `yield* TxPubSub.unbounded()`,
  TxQueue: `yield* TxQueue.unbounded()`,
  TxReentrantLock: `yield* TxReentrantLock.make()`,
  TxRef: `yield* TxRef.make(a)`,
  TxSemaphore: `yield* TxSemaphore.make(1)`,
  TxSubscriptionRef: `yield* TxSubscriptionRef.make(a)`,
  UndefinedOr: `a`,
};

/** The most calls one table holds. */
const PART = 1500;

const numbers = {
  input: `a: Small, b: Small`,
  pins: `[{ a: 1, b: 2 }]`,
  differs: `command.a !== pin.a || command.b !== pin.b`,
  bind: (known: boolean) =>
    known ? `const a = pin.a; const b = pin.b;` : `const a = command.a; const b = command.b;`,
};

/**
 * A call, made in a scope with a value of the module's own first: what it
 * gives is called when it is a function, with nothing and then with that
 * value, and run when it is an effect.
 */
const ran = (self: string | undefined, call: string): string =>
  `Effect.scoped(Effect.gen(function* () { ${self ? `const self = ${self}; ` : ""}const made = ${call}; const out = typeof made === "function" ? made() : made; ${self ? `const last = typeof out === "function" ? out(self) : out; ` : "const last = out; "}if (Effect.isEffect(last)) yield* Effect.exit(last); return 1; }))`;

/** One table for each module the prover has models of, named after it. */
export const misuseGroups = (only?: ReadonlyArray<string>): ReadonlyArray<Group> => {
  const byModule = new Map<string, Array<string>>();
  for (const key of surface().library) {
    const at = key.lastIndexOf(":");
    const module = key.slice(0, at);
    const path = key.slice(at + 1);
    if (!module.startsWith("effect/") || path === "" || /[^\w.$]/.test(path)) continue;
    byModule.set(module, [...(byModule.get(module) ?? []), path]);
  }
  const paths = process.env.MISUSE_PATHS?.split(",");
  return [...byModule]
    .filter(([module]) => !only || only.includes(module))
    .flatMap(([module, all]): ReadonlyArray<Group> => {
      const name = module.slice("effect/".length).replace(/\W/g, "");
      // The module is imported as `Under`: its own values are made with it.
      const own = SELF[name];
      const selves = (own === undefined ? [] : typeof own === "string" ? [own] : own).map((self) =>
        self.replaceAll(`${name}.`, "Under."),
      );
      const calls = all
        .filter((path) => !paths || paths.includes(path))
        .flatMap((path) => [
          ...SHAPES.map((shape) => ran(undefined, `Under.${path}(${shape})`)),
          ...selves.flatMap((self) => [
            ...AFTER.map((after) => ran(self, `Under.${path}(self${after ? `, ${after}` : ""})`)),
            ...AFTER.map((after) => ran(self, `Under.${path}(${after})(self)`)),
          ]),
        ]);
      // A large module is read in parts, each in the time a test is given.
      const parts = Math.ceil(calls.length / PART);
      return Array.from({ length: parts }, (_, index) => ({
        name: `Misuse${name}${parts > 1 ? index + 1 : ""}`,
        ...numbers,
        effectful: true,
        prelude: [`import * as Under from "${module}";`],
        both: [],
        misuse: calls.slice(index * PART, (index + 1) * PART),
      }));
    });
};
