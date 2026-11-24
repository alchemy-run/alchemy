import * as Effect from "effect/Effect";
import * as Brands from "./Brands.ts";
import * as Compare from "./Compare.ts";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { Eval, Run, Site, V } from "./Value.ts";
import * as Value from "./Value.ts";

/** What the library models need from the interpreter. */
export interface Host {
  readonly current: { run: Run };
  /** Take one side of a condition of the inputs: only a side some inputs reach. */
  readonly branch: (condition: string) => Eval<boolean>;
  readonly call: (fn: V, args: ReadonlyArray<V>, site: Site) => Eval<V>;
  /** What `yield*` on the value gives. */
  readonly settle: (value: V, site: Site) => Eval<V>;
  /** Whether a value is truthy on this path. */
  readonly decide: (value: V, site: Site) => Eval<boolean>;
  /** Whether a value is truthy, known or as a formula: the path is not split. */
  readonly truth: (value: V, site: Site) => Eval<boolean | string>;
  /** Whether two values are `===`, as a value: known, or a condition of the inputs. */
  readonly equal: (a: V, b: V, site: Site) => Eval<V>;
  /** `a + b` and the like, and `a < b` and the like, as the code's own operators give them. */
  readonly arithmetic: (operator: string, a: V, b: V, site: Site) => Eval<V>;
  /** A property of a value, as the code reads one. */
  readonly member: (value: V, key: string, site: Site) => Eval<V>;
  /** What `typeof` gives, for the values it is known of. */
  readonly kind: (value: V) => string | undefined;
  /** A list with its items, when the value is one. */
  readonly force: (value: V) => V;
  /**
   * What a function of the code gives where the library calls it at once.
   * It throws where the function cannot be run to its end there: one an
   * input decides is not.
   */
  readonly atOnce: (fn: V, args: ReadonlyArray<V>, site: Site) => V;
  /** A value the code being read has just made: it may change it, as it may what it wrote itself. */
  readonly fresh: <A extends V>(value: A) => A;
  /** An array's method that takes a function, such as `map`. */
  readonly array: (
    name: string,
    items: ReadonlyArray<V>,
    fn: V,
    initial: V | undefined,
    site: Site,
  ) => Eval<V>;
  /** The request contexts provided around the code being run, by tag. */
  readonly provided: Map<unknown, V>;
  /** The time the command being decided is handled at: none outside `decide`. */
  readonly now: () => V | undefined;
  /** Models a caller adds, by `module:path`. They come before the prover's own. */
  readonly extra: ReadonlyMap<string, Model>;
}

/** What a library function does to symbolic values. */
export type Model = (args: ReadonlyArray<V>, site: Site) => Eval<V>;

/** The models of one part of the library, by `module:path`. */
export type Models = Readonly<Record<string, Model>>;

export const native = (name: string, call: Model): V => ({ _tag: "Native", name, call });
export const effect = (run: Eval<V>): V => ({ _tag: "Effect", run });
export const done: V = effect(Effect.succeed(Value.undef));

/** An effect that does what `run` gives, each time it is run. */
export const lazy = (run: () => Eval<V>): V => Effect.suspend(run).pipe(effect);
export const arr = (items: ReadonlyArray<V>): V => ({ _tag: "Arr", items });

export const wrongArguments = (site: Site, name: string) =>
  Effect.fail(Value.notTranslated(site, `${name} is called in a way the prover has no model for`));

export const str = (v: V | undefined): string | undefined =>
  v?._tag === "Str" ? v.value : undefined;

/** Whether a value is something the code can call. */
export const callable = (v: V | undefined): v is V =>
  v?._tag === "Fn" || v?._tag === "Native" || v?._tag === "Lib" || v?._tag === "Host";

/**
 * A function written both ways: with what it works on first (`f(self, x)`),
 * or without it, to be given it by `pipe` (`f(x)` then `self`).
 */
export const dual =
  (name: string, arity: number, body: Model): Model =>
  (args, site) =>
    args.length >= arity
      ? body(args, site)
      : Effect.succeed<V>({
          _tag: "Native",
          name,
          given: args,
          call: ([self], at) => (self ? body([self, ...args], at) : wrongArguments(at, name)),
        });

/**
 * A function written both ways, where the number of arguments does not say
 * which: it is called with what it works on first when `first` takes its
 * first argument.
 */
export const dualBy =
  (name: string, first: (v: V) => boolean, body: Model): Model =>
  (args, site) =>
    args[0] && first(args[0])
      ? body(args, site)
      : Effect.succeed(
          native(name, ([self], at) =>
            self && first(self) ? body([self, ...args], at) : wrongArguments(at, name),
          ),
        );

/**
 * A function of an effect, called with the effect first (`f(effect, x)`) or
 * later through `pipe` (`f(x)` then the effect).
 */
export const onEffect =
  (
    name: string,
    extra: number,
    run: (self: Eval<V>, args: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
  (args, site) => {
    const [first, ...rest] = args;
    if (args.length === extra + 1 && first?._tag === "Effect")
      return Effect.suspend(() => run(first.run, rest, site)).pipe(effect, Effect.succeed);
    if (args.length === extra)
      return Effect.succeed(
        native(name, ([self], at) =>
          self?._tag === "Effect"
            ? Effect.suspend(() => run(self.run, args, at)).pipe(effect, Effect.succeed)
            : wrongArguments(at, name),
        ),
      );
    return wrongArguments(site, name);
  };

/** An effect that only a failure leaves: a rejection the code can handle, never a defect. */
export const onFailure = <A>(self: Eval<A>, handle: (error: V) => Eval<A>): Eval<A> =>
  self.pipe(
    Effect.catchTag("Rejected", (rejected) =>
      rejected.defect === true ? Effect.fail(rejected) : handle(rejected.rejection),
    ),
  );

export const tagsOf = (v: V | undefined): ReadonlyArray<string> | undefined =>
  v?._tag === "Str"
    ? [v.value]
    : v?._tag === "Arr" && v.items.every((item) => item._tag === "Str")
      ? v.items.map((item) => (item as { readonly value: string }).value)
      : undefined;

/** The `_tag` of an object, when the prover sees it. */
export const tagOf = (v: V | undefined): string | undefined =>
  v?._tag === "Obj" ? str(v.fields._tag) : undefined;

/** A whole number: one the prover knows, or a formula for one. */
export type Whole = number | Term;

export const wholeOf = (v: V | undefined): Whole | undefined =>
  v?._tag === "Num"
    ? Number.isSafeInteger(v.value)
      ? v.value
      : undefined
    : v?._tag === "Term" && v.term.sort === "Int" && v.big !== true
      ? v.term
      : undefined;

export const termOf = (n: Whole): Term => (typeof n === "number" ? Smt.int(n) : n);
export const valueOfWhole = (n: Whole): V =>
  typeof n === "number" ? Value.num(n) : { _tag: "Term", term: n };

export const sum = (a: Whole, b: Whole): Whole =>
  typeof a === "number" && typeof b === "number"
    ? a + b
    : { sort: "Int", text: `(+ ${termOf(a).text} ${termOf(b).text})` };
export const difference = (a: Whole, b: Whole): Whole =>
  typeof a === "number" && typeof b === "number"
    ? a - b
    : { sort: "Int", text: `(- ${termOf(a).text} ${termOf(b).text})` };
export const product = (a: Whole, b: Whole): Whole =>
  typeof a === "number" && typeof b === "number"
    ? a * b
    : { sort: "Int", text: `(* ${termOf(a).text} ${termOf(b).text})` };

const ORDER = {
  "<": (a: number, b: number) => a < b,
  "<=": (a: number, b: number) => a <= b,
  ">": (a: number, b: number) => a > b,
  ">=": (a: number, b: number) => a >= b,
  "=": (a: number, b: number) => a === b,
};

export const ordered = (order: keyof typeof ORDER, a: Whole, b: Whole): V =>
  typeof a === "number" && typeof b === "number"
    ? Value.bool(ORDER[order](a, b))
    : Value.term("Bool", `(${order} ${termOf(a).text} ${termOf(b).text})`);

/** The smaller of two, or the larger: the first where they are the same, as the library gives. */
export const picked = (order: "<=" | ">=", a: Whole, b: Whole): Whole =>
  typeof a === "number" && typeof b === "number"
    ? ORDER[order](a, b)
      ? a
      : b
    : {
        sort: "Int",
        text: `(ite (${order} ${termOf(a).text} ${termOf(b).text}) ${termOf(a).text} ${termOf(b).text})`,
      };

/** A key the code names: one the prover cannot see is not translated. */
export const keyed = (name: string, key: V | undefined, site: Site): Eval<string> =>
  key?._tag === "Str" || key?._tag === "Num"
    ? Effect.succeed(String(key.value))
    : Effect.fail(Value.notTranslated(site, `${name} is given a key the prover cannot see`));

export const keysOf = (
  name: string,
  keys: V | undefined,
  site: Site,
): Eval<ReadonlyArray<string>> =>
  keys?._tag === "Arr"
    ? Effect.forEach(keys.items, (key) => keyed(name, key, site))
    : Effect.fail(Value.notTranslated(site, `${name} is given keys the prover cannot see`));

/** A number the code writes, where the prover has to see one: a count, an index. */
export const counted = (name: string, n: V | undefined, site: Site): Eval<number> =>
  n?._tag === "Num" && Number.isInteger(n.value)
    ? Effect.succeed(n.value)
    : Effect.fail(Value.notTranslated(site, `${name} is given a count the prover cannot see`));

/** A function of an `Option`. */
export const onOption = (
  name: string,
  arity: number,
  body: (
    option: NonNullable<ReturnType<typeof Value.optionOf>>,
    rest: ReadonlyArray<V>,
    site: Site,
    self: V,
  ) => Eval<V>,
): Model =>
  dual(name, arity, ([self, ...rest], site) => {
    const option = Value.optionOf(self);
    return option && self ? body(option, rest, site, self) : wrongArguments(site, name);
  });

/** A function of an object whose keys the prover sees. */
export const onRecord = (
  name: string,
  arity: number,
  body: (fields: Readonly<Record<string, V>>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
): Model =>
  dual(name, arity, ([self, ...rest], site) =>
    self?._tag === "Obj" && !self.brand
      ? body(self.fields, rest, site)
      : wrongArguments(site, name),
  );

/** `n!`: the number of orders `n` items can be read in. */
const orders = (n: number): number => (n <= 1 ? 1 : n * orders(n - 1));

/** The most items of a hash set or a hash map the prover reads in every order. */
export const MAX_ORDERED = 4;

/** The helpers that need the interpreter. */
export const make = (host: Host) => {
  /**
   * What the library does when it is given something that is not an effect
   * where it runs one: it dies, and nothing that handles a failure handles it.
   */
  const invalid: Eval<never> = Effect.suspend(() =>
    Effect.fail(new Value.Rejected({ rejection: Value.str("Not a valid effect"), defect: true })),
  );

  /** What a step after an effect gives: an effect, or a function of its value that gives one. */
  const after = (next: V, value: V, site: Site): Eval<V> =>
    next._tag === "Effect"
      ? next.run
      : callable(next)
        ? host
            .call(next, [value], site)
            .pipe(Effect.flatMap((made) => (made._tag === "Effect" ? made.run : invalid)))
        : invalid;

  /** What the effect a function gives, gives. A function that gives anything else is not one the library runs. */
  const ran = (fn: V, args: ReadonlyArray<V>, site: Site): Eval<V> =>
    host
      .call(fn, args, site)
      .pipe(Effect.flatMap((made) => (made._tag === "Effect" ? made.run : invalid)));

  /** What a function gives, where the library takes an effect or a plain value. */
  const either = (fn: V, args: ReadonlyArray<V>, site: Site): Eval<V> =>
    host
      .call(fn, args, site)
      .pipe(Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))));

  /** The items of an array or of a list an input holds: `undefined` for anything else. */
  const itemsOf = (v: V | undefined): ReadonlyArray<V> | undefined => {
    const list = v ? host.force(v) : undefined;
    return list?._tag === "Arr" ? list.items : undefined;
  };

  /** A function of an array, whose items the prover has to see. */
  const onArray = (
    name: string,
    arity: number,
    body: (items: ReadonlyArray<V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const items = itemsOf(self);
      return items ? body(items, rest, site) : wrongArguments(site, name);
    });

  /** What is known of a condition, as a value: nothing known is not translated. */
  const known = (what: Compare.Known, site: Site, reason: string): Eval<V> =>
    what === undefined
      ? Effect.fail(Value.notTranslated(site, reason))
      : Effect.succeed(Compare.fromTruth(what));

  /** `Equal.equals(a, b)`, known or as a formula. */
  const equality = (a: V, b: V, site: Site): Eval<Compare.Known> => {
    const equal = Compare.equals(a, b, host.force);
    return equal === undefined
      ? Effect.fail(Value.notTranslated(site, "compares values the prover does not model"))
      : Effect.succeed(equal);
  };

  /** `Equal.equals(a, b)`, as a value. */
  const equals = (a: V, b: V, site: Site): Eval<V> =>
    Effect.map(equality(a, b, site), (equal) => Compare.fromTruth(equal as boolean | string));

  /** Whether a function holds of a value, on this path. */
  const holds = (fn: V, args: ReadonlyArray<V>, site: Site): Eval<boolean> =>
    host.call(fn, args, site).pipe(Effect.flatMap((held) => host.decide(held, site)));

  /** Whether a function holds of a value, known or as a formula: the path is not split. */
  const truthOf = (fn: V, args: ReadonlyArray<V>, site: Site): Eval<boolean | string> =>
    host.call(fn, args, site).pipe(Effect.flatMap((held) => host.truth(held, site)));

  /**
   * The items of a hash set, or the pairs of a hash map, in the order the
   * code reads them. The library gives them in the order of their hashes,
   * which the prover does not know, so every order is a path of its own.
   */
  const inOrder = (
    kind: "HashSet" | "HashMap",
    items: ReadonlyArray<V>,
    site: Site,
  ): Eval<ReadonlyArray<V>> => {
    if (items.length <= 1) return Effect.succeed(items);
    if (items.length > MAX_ORDERED)
      return Effect.fail(
        Value.notTranslated(
          site,
          `reads the ${items.length} items of a ${kind} in order, which is the order of their hashes: the prover reads up to ${MAX_ORDERED} in every order`,
        ),
      );
    // The order is the order of the hashes of what is held: the same items are read in the same order again.
    const keys = items.map(Value.keyOf);
    const key = `${kind} ${[...keys].sort().join(",")}`;
    const before = host.current.run.orders.find((order) => order.key === key);
    if (before) return Effect.succeed(before.items);
    const left = [...items];
    const taken: Array<V> = [];
    let chosen = host.current.run.choose(orders(items.length));
    for (let size = items.length; size > 0; size--) {
      const each = orders(size - 1);
      taken.push(...left.splice(Math.floor(chosen / each), 1));
      chosen %= each;
    }
    host.current.run.orders.push({ kind, key, items: taken });
    return Effect.succeed(taken);
  };

  /** The items of a hash set, as it is on this path: `undefined` when the value is not one. */
  const setItems = (v: V | undefined): ReadonlyArray<V> | undefined => itemsOf(Brands.setOf(v));

  /** The pairs of a hash map, as it is on this path: `undefined` when the value is not one. */
  const mapEntries = (v: V | undefined): ReadonlyArray<readonly [V, V]> | undefined => {
    const entries = itemsOf(Brands.mapOf(v));
    if (!entries) return undefined;
    const pairs: Array<readonly [V, V]> = [];
    for (const entry of entries) {
      const pair = itemsOf(entry);
      if (!pair || pair.length !== 2) return undefined;
      pairs.push([pair[0]!, pair[1]!]);
    }
    return pairs;
  };

  /**
   * What a loop or a spread goes over: an array's items, a hash set's, or a
   * hash map's pairs. `undefined` for a value that has none the prover sees.
   */
  const iterate = (v: V, site: Site): Eval<ReadonlyArray<V> | undefined> => {
    const items = itemsOf(v);
    if (items) return Effect.succeed(items);
    const members = setItems(v);
    if (members) return inOrder("HashSet", members, site);
    const entries = mapEntries(v);
    if (entries)
      return inOrder(
        "HashMap",
        entries.map(([key, value]) => arr([key, value])),
        site,
      );
    return Effect.succeed(undefined);
  };

  // What each order the library gives says of two values: whether the first comes before the second.
  const lesses = new WeakMap<object, (a: V, b: V, site: Site) => Eval<V>>();

  /**
   * An order the prover knows by what it says of two values. Called as the
   * library calls one, it gives `-1`, `0` or `1`.
   */
  const order = (name: string, less: (a: V, b: V, site: Site) => Eval<V>): V => {
    const made = native(name, ([a, b], site) =>
      a && b
        ? Effect.gen(function* () {
            if (yield* host.decide(yield* less(a, b, site), site)) return Value.num(-1);
            if (yield* host.decide(yield* less(b, a, site), site)) return Value.num(1);
            return Value.num(0);
          })
        : wrongArguments(site, name),
    );
    lesses.set(made, less);
    return made;
  };

  /** Whether an order puts `a` before `b`, as a value: one of the library's, or a function the code wrote. */
  const lessThan = (by: V | undefined, a: V, b: V, site: Site): Eval<V> => {
    const less = by ? lesses.get(by) : undefined;
    if (less) return less(a, b, site);
    return callable(by)
      ? host
          .call(by, [a, b], site)
          .pipe(Effect.flatMap((ordering) => host.arithmetic("<", ordering, Value.num(0), site)))
      : wrongArguments(site, "an order");
  };

  /** Whether an order puts `a` before `b`, on this path. */
  const before = (by: V | undefined, a: V, b: V, site: Site): Eval<boolean> =>
    lessThan(by, a, b, site).pipe(Effect.flatMap((less) => host.decide(less, site)));

  /** The items in the order an order gives them. Items it says nothing between keep their places. */
  const sorted = (items: ReadonlyArray<V>, by: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    Effect.gen(function* () {
      const out: Array<V> = [];
      for (const item of items) {
        let at = out.length;
        while (at > 0 && (yield* before(by, item, out[at - 1]!, site))) at--;
        out.splice(at, 0, item);
      }
      return out;
    });

  return {
    host,
    order,
    lessThan,
    before,
    sorted,
    after,
    ran,
    either,
    itemsOf,
    onArray,
    known,
    equality,
    equals,
    holds,
    truthOf,
    inOrder,
    setItems,
    mapEntries,
    iterate,
  };
};

export type Kit = ReturnType<typeof make>;
