import * as BigInt_ from "effect/BigInt";
import * as Effect from "effect/Effect";
import * as Number_ from "effect/Number";
import * as Option from "effect/Option";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dual, native, str, tagOf, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const big = (value: bigint): V => ({ _tag: "Big", value });

/**
 * `Number`, `BigInt`, `Boolean`, `Predicate`, `Function`, `Order`,
 * `Equivalence` and `Equal`: the small functions rules are written with.
 * Each does what the operator it stands for does.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  /** `a < b` and the like, as the code's own operator gives it. */
  const binary = (name: string, operator: string): Model =>
    dual(name, 2, ([a, b], site) =>
      a && b ? host.arithmetic(operator, a, b, site) : wrongArguments(site, name),
    );

  /** A condition of several values, as one formula: no path is split. */
  const formula = (
    values: ReadonlyArray<V>,
    site: Site,
    combine: (parts: ReadonlyArray<boolean | string>) => Compare.Known,
  ): Eval<V> =>
    Effect.map(
      Effect.forEach(values, (value) => host.truth(value, site)),
      (parts) => Compare.fromTruth(combine(parts) as boolean | string),
    );

  const not = (known: Compare.Known): Compare.Known => Compare.negate(known);

  /** The smaller of two numbers, or the larger, as one value: no path is split. */
  const pick = (name: string, largest: boolean, a: V, b: V, site: Site): Eval<V> => {
    if (a._tag === "Num" && b._tag === "Num")
      return Effect.succeed(
        Value.num(largest ? Math.max(a.value, b.value) : Math.min(a.value, b.value)),
      );
    if (a._tag === "Big" && b._tag === "Big")
      return Effect.succeed((largest ? a.value >= b.value : a.value <= b.value) ? a : b);
    const left = Compare.numeric(a);
    const right = Compare.numeric(b);
    if (!left || !right || Value.isBig(a) !== Value.isBig(b)) return wrongArguments(site, name);
    const [x, y] = Compare.promote(left, right);
    return Effect.succeed<V>({
      _tag: "Term",
      term: {
        sort: x.sort,
        text: `(ite (${largest ? ">=" : "<="} ${x.text} ${y.text}) ${x.text} ${y.text})`,
      },
      ...(Value.isBig(a) ? { big: true as const } : {}),
    });
  };

  const bounds = (options: V | undefined): readonly [V, V] | undefined => {
    const fields = options?._tag === "Obj" ? options.fields : undefined;
    return fields?.minimum && fields.maximum ? [fields.minimum, fields.maximum] : undefined;
  };

  /** `between(self, { minimum, maximum })`: both ends count. */
  const between = (name: string): Model =>
    dual(name, 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.gen(function* () {
            const above = yield* host.arithmetic(">=", self, ends[0], site);
            const below = yield* host.arithmetic("<=", self, ends[1], site);
            return yield* formula([above, below], site, Compare.all);
          })
        : wrongArguments(site, name);
    });

  const clamp = (name: string): Model =>
    dual(name, 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.flatMap(pick(name, true, self, ends[0], site), (raised) =>
            pick(name, false, raised, ends[1], site),
          )
        : wrongArguments(site, name);
    });

  /** `-1`, `0` or `1`: which side of zero a number is on. */
  const sign =
    (name: string, zero: V): Model =>
    ([n], site) =>
      n
        ? Effect.gen(function* () {
            if (yield* host.decide(yield* host.arithmetic("<", n, zero, site), site))
              return Value.num(-1);
            return (yield* host.decide(yield* host.arithmetic(">", n, zero, site), site))
              ? Value.num(1)
              : Value.num(0);
          })
        : wrongArguments(site, name);

  /** `sumAll` and `multiplyAll`: one operator over every item. */
  const folded =
    (name: string, operator: string, initial: V): Model =>
    ([collection], site) =>
      collection
        ? Effect.gen(function* () {
            const items = yield* kit.iterate(collection, site);
            if (!items) return yield* wrongArguments(site, name);
            let total = initial;
            for (const item of items) total = yield* host.arithmetic(operator, total, item, site);
            return total;
          })
        : wrongArguments(site, name);

  /** A division: nothing when the divisor is zero. */
  const divided = (name: string, zero: V): Model =>
    dual(name, 2, ([a, b], site) =>
      a && b
        ? Effect.gen(function* () {
            if (yield* host.decide(yield* host.equal(b, zero, site), site)) return Value.none;
            return Value.some(yield* host.arithmetic("/", a, b, site));
          })
        : wrongArguments(site, name),
    );

  const typed =
    (name: string, kind: string): Model =>
    ([value], site) => {
      const found = value ? host.kind(value) : undefined;
      return found === undefined
        ? wrongArguments(site, name)
        : Effect.succeed(Value.bool(found === kind));
    };

  const option = (found: Option.Option<number | bigint>): V =>
    Option.isSome(found)
      ? Value.some(typeof found.value === "bigint" ? big(found.value) : Value.num(found.value))
      : Value.none;

  const numbers: Models = {
    "effect/Number:sum": binary("Number.sum", "+"),
    "effect/Number:subtract": binary("Number.subtract", "-"),
    "effect/Number:multiply": binary("Number.multiply", "*"),
    "effect/Number:divideUnsafe": binary("Number.divideUnsafe", "/"),
    "effect/Number:divide": divided("Number.divide", Value.num(0)),
    "effect/Number:isLessThan": binary("Number.isLessThan", "<"),
    "effect/Number:isLessThanOrEqualTo": binary("Number.isLessThanOrEqualTo", "<="),
    "effect/Number:isGreaterThan": binary("Number.isGreaterThan", ">"),
    "effect/Number:isGreaterThanOrEqualTo": binary("Number.isGreaterThanOrEqualTo", ">="),
    "effect/Number:increment": ([n], site) =>
      n ? host.arithmetic("+", n, Value.num(1), site) : wrongArguments(site, "Number.increment"),
    "effect/Number:decrement": ([n], site) =>
      n ? host.arithmetic("-", n, Value.num(1), site) : wrongArguments(site, "Number.decrement"),
    "effect/Number:min": dual("Number.min", 2, ([a, b], site) =>
      a && b ? pick("Number.min", false, a, b, site) : wrongArguments(site, "Number.min"),
    ),
    "effect/Number:max": dual("Number.max", 2, ([a, b], site) =>
      a && b ? pick("Number.max", true, a, b, site) : wrongArguments(site, "Number.max"),
    ),
    "effect/Number:between": between("Number.between"),
    "effect/Number:clamp": clamp("Number.clamp"),
    "effect/Number:sign": sign("Number.sign", Value.num(0)),
    // The remainder of whole numbers, which is what `%` gives.
    "effect/Number:remainder": dual("Number.remainder", 2, ([a, b], site) =>
      a &&
      b &&
      (a._tag !== "Num" || Number.isInteger(a.value)) &&
      (b._tag !== "Num" || Number.isInteger(b.value))
        ? host.arithmetic("%", a, b, site)
        : wrongArguments(site, "Number.remainder"),
    ),
    "effect/Number:sumAll": folded("Number.sumAll", "+", Value.num(0)),
    "effect/Number:multiplyAll": folded("Number.multiplyAll", "*", Value.num(1)),
    "effect/Number:isNumber": typed("Number.isNumber", "number"),
    "effect/Number:round": dual("Number.round", 2, ([n, precision], site) =>
      n?._tag === "Num" && precision?._tag === "Num"
        ? Effect.succeed(Value.num(Number_.round(n.value, precision.value)))
        : wrongArguments(site, "Number.round"),
    ),
    "effect/Number:parse": ([text], site) =>
      text?._tag === "Str"
        ? Effect.succeed(Number_.parse(text.value).pipe(option))
        : wrongArguments(site, "Number.parse"),
    "effect/BigInt:sum": binary("BigInt.sum", "+"),
    "effect/BigInt:subtract": binary("BigInt.subtract", "-"),
    "effect/BigInt:multiply": binary("BigInt.multiply", "*"),
    "effect/BigInt:divideUnsafe": binary("BigInt.divideUnsafe", "/"),
    "effect/BigInt:divide": divided("BigInt.divide", big(0n)),
    "effect/BigInt:remainder": binary("BigInt.remainder", "%"),
    "effect/BigInt:isLessThan": binary("BigInt.isLessThan", "<"),
    "effect/BigInt:isLessThanOrEqualTo": binary("BigInt.isLessThanOrEqualTo", "<="),
    "effect/BigInt:isGreaterThan": binary("BigInt.isGreaterThan", ">"),
    "effect/BigInt:isGreaterThanOrEqualTo": binary("BigInt.isGreaterThanOrEqualTo", ">="),
    "effect/BigInt:increment": ([n], site) =>
      n ? host.arithmetic("+", n, big(1n), site) : wrongArguments(site, "BigInt.increment"),
    "effect/BigInt:decrement": ([n], site) =>
      n ? host.arithmetic("-", n, big(1n), site) : wrongArguments(site, "BigInt.decrement"),
    "effect/BigInt:min": dual("BigInt.min", 2, ([a, b], site) =>
      a && b ? pick("BigInt.min", false, a, b, site) : wrongArguments(site, "BigInt.min"),
    ),
    "effect/BigInt:max": dual("BigInt.max", 2, ([a, b], site) =>
      a && b ? pick("BigInt.max", true, a, b, site) : wrongArguments(site, "BigInt.max"),
    ),
    "effect/BigInt:between": between("BigInt.between"),
    "effect/BigInt:clamp": clamp("BigInt.clamp"),
    "effect/BigInt:sign": sign("BigInt.sign", big(0n)),
    "effect/BigInt:abs": ([n], site) =>
      n
        ? Effect.flatMap(host.arithmetic("-", big(0n), n, site), (negated) =>
            pick("BigInt.abs", true, n, negated, site),
          )
        : wrongArguments(site, "BigInt.abs"),
    "effect/BigInt:sumAll": folded("BigInt.sumAll", "+", big(0n)),
    "effect/BigInt:multiplyAll": folded("BigInt.multiplyAll", "*", big(1n)),
    "effect/BigInt:isBigInt": typed("BigInt.isBigInt", "bigint"),
    "effect/BigInt:toNumber": ([n], site) =>
      n?._tag === "Big"
        ? Effect.succeed(BigInt_.toNumber(n.value).pipe(option))
        : wrongArguments(site, "BigInt.toNumber"),
    "effect/BigInt:fromNumber": ([n], site) =>
      n?._tag === "Num"
        ? Effect.succeed(BigInt_.fromNumber(n.value).pipe(option))
        : wrongArguments(site, "BigInt.fromNumber"),
    "effect/BigInt:fromString": ([text], site) =>
      text?._tag === "Str"
        ? Effect.succeed(BigInt_.fromString(text.value).pipe(option))
        : wrongArguments(site, "BigInt.fromString"),
    "effect/BigInt:gcd": dual("BigInt.gcd", 2, ([a, b], site) =>
      a?._tag === "Big" && b?._tag === "Big"
        ? Effect.succeed(big(BigInt_.gcd(a.value, b.value)))
        : wrongArguments(site, "BigInt.gcd"),
    ),
    "effect/BigInt:lcm": dual("BigInt.lcm", 2, ([a, b], site) =>
      a?._tag === "Big" && b?._tag === "Big"
        ? Effect.succeed(big(BigInt_.lcm(a.value, b.value)))
        : wrongArguments(site, "BigInt.lcm"),
    ),
    "effect/BigInt:sqrt": ([n], site) =>
      n?._tag === "Big"
        ? Effect.succeed(BigInt_.sqrt(n.value).pipe(option))
        : wrongArguments(site, "BigInt.sqrt"),
  };

  /** A test of two booleans: `Boolean.and` and the like. */
  const logic = (
    name: string,
    combine: (a: boolean | string, b: boolean | string) => Compare.Known,
  ): Model =>
    dual(name, 2, ([a, b], site) =>
      a && b ? formula([a, b], site, ([x, y]) => combine(x!, y!)) : wrongArguments(site, name),
    );

  const and = (a: Compare.Known, b: Compare.Known) => Compare.all([a, b]);
  const or = (a: Compare.Known, b: Compare.Known) => Compare.any([a, b]);
  const eqv = (a: Compare.Known, b: Compare.Known) => or(and(a, b), and(not(a), not(b)));
  const xor = (a: Compare.Known, b: Compare.Known) => not(eqv(a, b));

  const LOGIC: Readonly<Record<string, (a: Compare.Known, b: Compare.Known) => Compare.Known>> = {
    and,
    or,
    xor,
    eqv,
    nand: (a, b) => not(and(a, b)),
    nor: (a, b) => not(or(a, b)),
    implies: (a, b) => or(not(a), b),
  };

  /** Every item of a collection is truthy, or some is: one formula. */
  const quantified =
    (name: string, combine: (parts: ReadonlyArray<boolean | string>) => Compare.Known): Model =>
    ([collection], site) =>
      collection
        ? Effect.flatMap(kit.iterate(collection, site), (items) =>
            items ? formula(items, site, combine) : wrongArguments(site, name),
          )
        : wrongArguments(site, name);

  const booleans: Models = {
    ...Object.fromEntries(
      Object.entries(LOGIC).map(([name, combine]) => [
        `effect/Boolean:${name}`,
        logic(`Boolean.${name}`, combine),
      ]),
    ),
    "effect/Boolean:not": ([value], site) =>
      value ? formula([value], site, ([x]) => not(x)) : wrongArguments(site, "Boolean.not"),
    "effect/Boolean:isBoolean": typed("Boolean.isBoolean", "boolean"),
    "effect/Boolean:match": dual("Boolean.match", 2, ([value, cases], site) => {
      const fields = cases?._tag === "Obj" ? cases.fields : undefined;
      return value && fields?.onTrue && fields.onFalse
        ? Effect.flatMap(host.decide(value, site), (held) =>
            host.call(held ? fields.onTrue! : fields.onFalse!, [], site),
          )
        : wrongArguments(site, "Boolean.match");
    }),
    "effect/Boolean:every": quantified("Boolean.every", Compare.all),
    "effect/Boolean:some": quantified("Boolean.some", Compare.any),
  };

  /** A predicate made of others: called, it gives one formula of what they give. */
  const combined = (
    name: string,
    combine: (a: Compare.Known, b: Compare.Known) => Compare.Known,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      callable(self) && callable(that)
        ? Effect.succeed(
            native(name, (args, at) =>
              Effect.gen(function* () {
                const a = yield* kit.truthOf(self, args, at);
                const b = yield* kit.truthOf(that, args, at);
                return Compare.fromTruth(combine(a, b) as boolean | string);
              }),
            ),
          )
        : wrongArguments(site, name),
    );

  /** A test of what a value is, which the prover knows of every value it sees into. */
  const guard =
    (name: string, test: (v: V) => boolean): Model =>
    ([value], site) =>
      value && value._tag !== "Opaque" && value._tag !== "Applied"
        ? Effect.succeed(Value.bool(test(value)))
        : wrongArguments(site, name);

  const nothing = (v: V) => v._tag === "Null" || v._tag === "Undef";

  const predicates: Models = {
    ...Object.fromEntries(
      Object.entries(LOGIC).map(([name, combine]) => [
        `effect/Predicate:${name}`,
        combined(`Predicate.${name}`, combine),
      ]),
    ),
    "effect/Predicate:not": ([self], site) =>
      callable(self)
        ? Effect.succeed(
            native("Predicate.not", (args, at) =>
              Effect.map(kit.truthOf(self, args, at), (held) =>
                Compare.fromTruth(not(held) as boolean | string),
              ),
            ),
          )
        : wrongArguments(site, "Predicate.not"),
    "effect/Predicate:mapInput": dual("Predicate.mapInput", 2, ([self, f], site) =>
      callable(self) && callable(f)
        ? Effect.succeed(
            native("Predicate.mapInput", ([value], at) =>
              Effect.flatMap(host.call(f, [value ?? Value.undef], at), (made) =>
                host.call(self, [made], at),
              ),
            ),
          )
        : wrongArguments(site, "Predicate.mapInput"),
    ),
    "effect/Predicate:isString": typed("Predicate.isString", "string"),
    "effect/Predicate:isNumber": typed("Predicate.isNumber", "number"),
    "effect/Predicate:isBoolean": typed("Predicate.isBoolean", "boolean"),
    "effect/Predicate:isBigInt": typed("Predicate.isBigInt", "bigint"),
    "effect/Predicate:isFunction": typed("Predicate.isFunction", "function"),
    "effect/Predicate:isUndefined": guard("Predicate.isUndefined", (v) => v._tag === "Undef"),
    "effect/Predicate:isNotUndefined": guard("Predicate.isNotUndefined", (v) => v._tag !== "Undef"),
    "effect/Predicate:isNull": guard("Predicate.isNull", (v) => v._tag === "Null"),
    "effect/Predicate:isNotNull": guard("Predicate.isNotNull", (v) => v._tag !== "Null"),
    "effect/Predicate:isNullish": guard("Predicate.isNullish", nothing),
    "effect/Predicate:isNotNullish": guard("Predicate.isNotNullish", (v) => !nothing(v)),
    "effect/Predicate:isTruthy": ([value], site) =>
      value ? formula([value], site, ([x]) => x) : wrongArguments(site, "Predicate.isTruthy"),
    "effect/Predicate:isTagged": dual("Predicate.isTagged", 2, ([self, tag], site) => {
      const name = str(tag);
      return self && name !== undefined && self._tag !== "Opaque" && self._tag !== "Applied"
        ? Effect.succeed(Value.bool(tagOf(self) === name))
        : wrongArguments(site, "Predicate.isTagged");
    }),
    "effect/Predicate:hasProperty": dual("Predicate.hasProperty", 2, ([self, key], site) => {
      const name = str(key);
      return self && name !== undefined && self._tag !== "Opaque" && self._tag !== "Applied"
        ? Effect.succeed(Value.bool(self._tag === "Obj" && Object.hasOwn(self.fields, name)))
        : wrongArguments(site, "Predicate.hasProperty");
    }),
  };

  const constant =
    (value: V): Model =>
    () =>
      Effect.succeed(value);

  /** `flow(f, g)`: a function that gives each what the one before gave. */
  const flow: Model = (steps, site) =>
    steps.length > 0 && steps.every(callable)
      ? Effect.succeed(
          native(
            "flow",
            Effect.fnUntraced(function* (args: ReadonlyArray<V>, at: Site) {
              let value = yield* host.call(steps[0]!, args, at);
              for (const step of steps.slice(1)) value = yield* host.call(step, [value], at);
              return value;
            }),
          ),
        )
      : wrongArguments(site, "flow");

  const functions: Models = {
    "effect/Function:identity": ([value]) => Effect.succeed(value ?? Value.undef),
    "effect/Function:constant": ([value]) =>
      Effect.succeed(native("constant", () => Effect.succeed(value ?? Value.undef))),
    "effect/Function:constTrue": constant(Value.bool(true)),
    "effect/Function:constFalse": constant(Value.bool(false)),
    "effect/Function:constNull": constant(Value.nil),
    "effect/Function:constUndefined": constant(Value.undef),
    "effect/Function:constVoid": constant(Value.undef),
    "effect/Function:flow": flow,
    "effect/Function:compose": dual("compose", 2, ([ab, bc], site) =>
      ab && bc ? flow([ab, bc], site) : wrongArguments(site, "compose"),
    ),
    "effect/Function:apply": (args) =>
      Effect.succeed(
        native("apply", ([f], site) =>
          f ? host.call(f, args, site) : wrongArguments(site, "apply"),
        ),
      ),
    "effect/Function:tupled": ([f], site) =>
      f
        ? Effect.succeed(
            native("tupled", ([tuple], at) => {
              const items = kit.itemsOf(tuple);
              return items ? host.call(f, items, at) : wrongArguments(at, "tupled");
            }),
          )
        : wrongArguments(site, "tupled"),
    "effect/Function:untupled": ([f], site) =>
      f
        ? Effect.succeed(native("untupled", (args, at) => host.call(f, [arr(args)], at)))
        : wrongArguments(site, "untupled"),
    "effect/Function:flip": ([f], site) =>
      f
        ? Effect.succeed(
            native("flip", (b) =>
              Effect.succeed(
                native("flip", (a, at) =>
                  Effect.flatMap(host.call(f, a, at), (inner) => host.call(inner, b, at)),
                ),
              ),
            ),
          )
        : wrongArguments(site, "flip"),
    // `dual(2, body)`: `body` called with everything, or without its first argument, which comes after.
    "effect/Function:dual": ([arity, body], site) =>
      arity && body
        ? Effect.succeed(
            native("dual", (args, at) =>
              Effect.gen(function* () {
                const first =
                  arity._tag === "Num"
                    ? args.length >= arity.value
                    : yield* kit.holds(arity, [arr(args)], at);
                return first
                  ? yield* host.call(body, args, at)
                  : native("dual", ([self], then) =>
                      self ? host.call(body, [self, ...args], then) : wrongArguments(then, "dual"),
                    );
              }),
            ),
          )
        : wrongArguments(site, "dual"),
    "effect/Function:satisfies": () =>
      Effect.succeed(native("satisfies", ([value]) => Effect.succeed(value ?? Value.undef))),
    "effect/Function:cast": ([value]) => Effect.succeed(value ?? Value.undef),
    "effect/Function:memoize": ([f], site) =>
      f ? Effect.succeed(f) : wrongArguments(site, "memoize"),
    "effect/Function:absurd": (_, site) =>
      Effect.fail(
        Value.notTranslated(site, "reaches absurd, which the code says cannot be reached"),
      ),
    "effect/Function:hole": (_, site) =>
      Effect.fail(Value.notTranslated(site, "reaches hole, which the code says cannot be reached")),
    // The second of two values.
    "effect/Function:SK": ([, second]) => Effect.succeed(second ?? Value.undef),
    // A brand is a name for a type: the value is what it was.
    "effect/Brand:nominal": () =>
      Effect.succeed(native("Brand.nominal", ([value]) => Effect.succeed(value ?? Value.undef))),
    "effect/Equal:equals": dual("Equal.equals", 2, ([a, b], site) =>
      a && b ? kit.equals(a, b, site) : wrongArguments(site, "Equal.equals"),
    ),
  };

  // Orders. Each is known by whether it puts one value before another.

  const numberOrder = kit.order("Order.Number", (a, b, site) => host.arithmetic("<", a, b, site));
  const stringOrder = kit.order("Order.String", (a, b, site) =>
    a._tag === "Str" && b._tag === "Str"
      ? Effect.succeed(Value.bool(a.value < b.value))
      : Effect.fail(
          Value.notTranslated(
            site,
            "orders strings an input holds, which the prover does not translate",
          ),
        ),
  );
  const booleanOrder = kit.order("Order.Boolean", (a, b, site) =>
    formula([a, b], site, ([x, y]) => Compare.all([not(x), y])),
  );

  /** An order of the library's, or a function the code wrote as one. */
  const isOrder = (v: V | undefined): v is V => callable(v);

  /** A test two values pass under an order: `Order.isLessThan(order)` and the like. */
  const comparing =
    (name: string, test: (by: V, a: V, b: V, site: Site) => Eval<V>): Model =>
    ([by], site) =>
      isOrder(by)
        ? Effect.succeed(
            native(
              name,
              dual(name, 2, ([a, b], at) =>
                a && b ? test(by, a, b, at) : wrongArguments(at, name),
              ),
            ),
          )
        : wrongArguments(site, name);

  const negated = (value: Eval<V>, site: Site): Eval<V> =>
    Effect.flatMap(value, (held) => formula([held], site, ([x]) => not(x)));

  /** The first of two under an order, or the second: the first where the order says nothing between them. */
  const chosen = (largest: boolean) => (by: V, a: V, b: V, site: Site) =>
    Effect.map(largest ? kit.before(by, a, b, site) : kit.before(by, b, a, site), (other) =>
      other ? b : a,
    );

  const orders: Models = {
    "effect/Order:make": ([compare], site) =>
      callable(compare) ? Effect.succeed(compare) : wrongArguments(site, "Order.make"),
    "effect/Order:flip": ([by], site) =>
      isOrder(by)
        ? Effect.succeed(kit.order("Order.flip", (a, b, at) => kit.lessThan(by, b, a, at)))
        : wrongArguments(site, "Order.flip"),
    "effect/Order:mapInput": dual("Order.mapInput", 2, ([by, f], site) =>
      isOrder(by) && callable(f)
        ? Effect.succeed(
            kit.order("Order.mapInput", (a, b, at) =>
              Effect.gen(function* () {
                return yield* kit.lessThan(
                  by,
                  yield* host.call(f, [a], at),
                  yield* host.call(f, [b], at),
                  at,
                );
              }),
            ),
          )
        : wrongArguments(site, "Order.mapInput"),
    ),
    // By the first order, and by the second where the first says nothing.
    "effect/Order:combine": dual("Order.combine", 2, ([first, second], site) =>
      isOrder(first) && isOrder(second)
        ? Effect.succeed(
            kit.order("Order.combine", (a, b, at) =>
              Effect.gen(function* () {
                if (yield* kit.before(first, a, b, at)) return Value.bool(true);
                if (yield* kit.before(first, b, a, at)) return Value.bool(false);
                return yield* kit.lessThan(second, a, b, at);
              }),
            ),
          )
        : wrongArguments(site, "Order.combine"),
    ),
    "effect/Order:isLessThan": comparing("Order.isLessThan", (by, a, b, site) =>
      kit.lessThan(by, a, b, site),
    ),
    "effect/Order:isGreaterThan": comparing("Order.isGreaterThan", (by, a, b, site) =>
      kit.lessThan(by, b, a, site),
    ),
    "effect/Order:isLessThanOrEqualTo": comparing("Order.isLessThanOrEqualTo", (by, a, b, site) =>
      negated(kit.lessThan(by, b, a, site), site),
    ),
    "effect/Order:isGreaterThanOrEqualTo": comparing(
      "Order.isGreaterThanOrEqualTo",
      (by, a, b, site) => negated(kit.lessThan(by, a, b, site), site),
    ),
    "effect/Order:min": comparing("Order.min", chosen(false)),
    "effect/Order:max": comparing("Order.max", chosen(true)),
    // As the library does it: the larger of the least and the value, then the smaller of the most and that.
    "effect/Order:clamp": comparing("Order.clamp", (by, self, options, site) => {
      const ends = bounds(options);
      return ends
        ? Effect.flatMap(chosen(true)(by, ends[0], self, site), (raised) =>
            chosen(false)(by, ends[1], raised, site),
          )
        : wrongArguments(site, "Order.clamp");
    }),
    "effect/Order:isBetween": comparing("Order.isBetween", (by, self, options, site) => {
      const ends = bounds(options);
      return ends
        ? Effect.gen(function* () {
            const below = yield* kit.lessThan(by, self, ends[0], site);
            const above = yield* kit.lessThan(by, ends[1], self, site);
            return yield* formula([below, above], site, ([x, y]) => Compare.all([not(x), not(y)]));
          })
        : wrongArguments(site, "Order.isBetween");
    }),
    "effect/Equivalence:make": ([same], site) =>
      callable(same) ? Effect.succeed(same) : wrongArguments(site, "Equivalence.make"),
    "effect/Equivalence:strictEqual": () => Effect.succeed(strict),
    "effect/Equivalence:mapInput": dual("Equivalence.mapInput", 2, ([same, f], site) =>
      callable(same) && callable(f)
        ? Effect.succeed(
            native("Equivalence.mapInput", ([a, b], at) =>
              a && b
                ? Effect.gen(function* () {
                    return yield* host.call(
                      same,
                      [yield* host.call(f, [a], at), yield* host.call(f, [b], at)],
                      at,
                    );
                  })
                : wrongArguments(at, "Equivalence.mapInput"),
            ),
          )
        : wrongArguments(site, "Equivalence.mapInput"),
    ),
  };

  const strict = native("Equivalence.strictEqual", ([a, b], site) =>
    a && b ? host.equal(a, b, site) : wrongArguments(site, "Equivalence.strictEqual"),
  );

  const values: Record<string, V> = {
    "effect/Order:Number": numberOrder,
    "effect/Order:BigInt": numberOrder,
    "effect/Order:String": stringOrder,
    "effect/Order:Boolean": booleanOrder,
    "effect/Number:Order": numberOrder,
    "effect/BigInt:Order": numberOrder,
    "effect/String:Order": stringOrder,
    "effect/Boolean:Order": booleanOrder,
    "effect/Number:Equivalence": strict,
    "effect/BigInt:Equivalence": strict,
    "effect/String:Equivalence": strict,
    "effect/Boolean:Equivalence": strict,
    "effect/Equivalence:Number": strict,
    "effect/Equivalence:BigInt": strict,
    "effect/Equivalence:String": strict,
    "effect/Equivalence:Boolean": strict,
  };

  return {
    models: { ...numbers, ...booleans, ...predicates, ...functions, ...orders } as Models,
    values,
    pick,
  };
};
