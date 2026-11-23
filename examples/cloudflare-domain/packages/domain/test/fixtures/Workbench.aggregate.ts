import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as BigInts from "effect/BigInt";
import * as Boolean from "effect/Boolean";
import * as Cause from "effect/Cause";
import * as Chunk from "effect/Chunk";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Equivalence from "effect/Equivalence";
import * as Exit from "effect/Exit";
import * as Filter from "effect/Filter";
import {
  apply,
  compose,
  constant,
  constTrue,
  dual,
  flip,
  flow,
  identity,
  pipe,
  tupled,
  untupled,
} from "effect/Function";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as MutableRef from "effect/MutableRef";
import * as Number from "effect/Number";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ordering from "effect/Ordering";
import * as Predicate from "effect/Predicate";
import * as Rational from "effect/Rational";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as String from "effect/String";
import * as Struct from "effect/Struct";
import * as Tuple from "effect/Tuple";
import * as UndefinedOr from "effect/UndefinedOr";

// One command for each part of the library. Each computes many values from
// its inputs, and records them: the prover reads every one, and the real
// code is then run on inputs of every path, and has to give the same.

const Small = Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }));

export class Worked extends Domain.Event("Worked", { results: Schema.Unknown }) {}

export class Count extends Domain.Command("Count", {
  input: { id: Schema.String, a: Small, b: Small, flag: Schema.Boolean },
  events: [Worked],
}) {}

const Numbers = { id: Schema.String, a: Small, b: Small, flag: Schema.Boolean };

export class Judge extends Domain.Command("Judge", { input: Numbers, events: [Worked] }) {}

export class Rank extends Domain.Command("Rank", { input: Numbers, events: [Worked] }) {}

export class Spell extends Domain.Command("Spell", {
  input: { id: Schema.String, text: Schema.String, other: Schema.String },
  events: [Worked],
}) {}

const Items = { id: Schema.String, items: Schema.Array(Small), a: Small };

export class Sort extends Domain.Command("Sort", { input: Items, events: [Worked] }) {}

export class Slice extends Domain.Command("Slice", { input: Items, events: [Worked] }) {}

export class Combine extends Domain.Command("Combine", { input: Items, events: [Worked] }) {}

export class Join extends Domain.Command("Join", { input: Items, events: [Worked] }) {}

export class Search extends Domain.Command("Search", { input: Items, events: [Worked] }) {}

export class Change extends Domain.Command("Change", { input: Items, events: [Worked] }) {}

export class Keep extends Domain.Command("Keep", { input: Items, events: [Worked] }) {}

export class Weigh extends Domain.Command("Weigh", {
  input: { id: Schema.String, a: Small, maybe: Schema.Option(Small) },
  events: [Worked],
}) {}

export class Price extends Domain.Command("Price", {
  input: { id: Schema.String, amount: Schema.BigDecimal, a: Small, wait: Schema.Duration },
  events: [Worked],
}) {}

export class Gather extends Domain.Command("Gather", {
  input: { id: Schema.String, members: Schema.HashSet(Small), a: Small },
  events: [Worked],
}) {}

export class Members extends Domain.Command("Members", {
  input: { id: Schema.String, members: Schema.HashSet(Small), a: Small },
  events: [Worked],
}) {}

export class Tally extends Domain.Command("Tally", {
  input: { id: Schema.String, scores: Schema.HashMap(Schema.String, Small), a: Small },
  events: [Worked],
}) {}

export class Pour extends Domain.Command("Pour", {
  input: { id: Schema.String, items: Schema.Array(Small), a: Small },
  events: [Worked],
}) {}

export class Run extends Domain.Command("Run", {
  input: { id: Schema.String, a: Small, b: Small },
  events: [Worked],
}) {}

export class Extra extends Domain.Command("Extra", {
  input: { id: Schema.String, a: Small, b: Small },
  events: [Worked],
}) {}

export class Rest extends Domain.Command("Rest", { input: Items, events: [Worked] }) {}

export class Flow extends Domain.Command("Flow", { input: Items, events: [Worked] }) {}

class Odd extends Data.TaggedError("Odd")<{ readonly n: number }> {}
class Negative extends Data.TaggedError("Negative")<{ readonly n: number }> {}

type Shape = Data.TaggedEnum<{ Dot: {}; Line: { readonly length: number } }>;
const Shape = Data.taggedEnum<Shape>();

const even = (n: number): Effect.Effect<number, Odd> =>
  n % 2 === 0 ? Effect.succeed(n) : Effect.fail(new Odd({ n }));
const positive = (n: number): Effect.Effect<number, Negative> =>
  n >= 0 ? Effect.succeed(n) : Effect.fail(new Negative({ n }));
const halved = (n: number): Result.Result<number, string> =>
  n % 2 === 0 ? Result.succeed(n * 3) : Result.fail("odd");
const add = dual<(b: number) => (a: number) => number, (a: number, b: number) => number>(
  2,
  (a, b) => a + b,
);

const third = Rational.makeUnsafe(1n, 3n);

const byN = Order.mapInput(
  Order.Number,
  (pair: { readonly n: number; readonly from: string }) => pair.n,
);

const counted = (a: number, b: number, flag: boolean) => ({
  sum: Number.sum(a, b),
  subtract: pipe(a, Number.subtract(b)),
  multiply: Number.multiply(a, b),
  divide: Number.divide(a, 4),
  byZero: Number.divide(a, 0),
  increment: Number.increment(a),
  decrement: Number.decrement(a),
  less: Number.isLessThan(a, b),
  atMost: Number.isLessThanOrEqualTo(a, b),
  more: Number.isGreaterThan(a, b),
  atLeast: pipe(a, Number.isGreaterThanOrEqualTo(b)),
  min: Number.min(a, b),
  max: Number.max(a, b),
  between: Number.between(a, { minimum: -5, maximum: 5 }),
  clamp: Number.clamp(a, { minimum: -5, maximum: 5 }),
  sign: Number.sign(a),
  remainder: Number.remainder(a, 3),
  sumAll: Number.sumAll([a, b, 1]),
  multiplyAll: Number.multiplyAll([a, 2]),
  isNumber: Number.isNumber(a),
  parse: Number.parse("12.5"),
  round: Number.round(2.345, 2),
  bigSum: BigInts.sum(BigInt(a), 2n),
  bigMultiply: BigInts.multiply(BigInt(a), BigInt(b)),
  bigAbs: BigInts.abs(BigInt(a)),
  bigSign: BigInts.sign(BigInt(b)),
  bigMax: BigInts.max(BigInt(a), BigInt(b)),
  bigLess: BigInts.isLessThan(BigInt(a), BigInt(b)),
  bigDivide: BigInts.divide(BigInt(a), 3n),
  bigGcd: BigInts.gcd(12n, 18n),
  bigToNumber: BigInts.toNumber(7n),
});

const judged = (a: number, b: number, flag: boolean) => ({
  and: Boolean.and(flag, a > 0),
  or: Boolean.or(flag, a > 0),
  not: Boolean.not(flag),
  xor: Boolean.xor(flag, a > b),
  implies: Boolean.implies(flag, a > b),
  eqv: Boolean.eqv(flag, a > b),
  nand: Boolean.nand(flag, a > b),
  nor: Boolean.nor(flag, a > b),
  matched: Boolean.match(flag, { onFalse: () => a, onTrue: () => b }),
  every: Boolean.every([flag, a > 0]),
  some: Boolean.some([flag, a > 0]),
  both: Predicate.and(
    (n: number) => n > 0,
    (n: number) => n < 10,
  )(a),
  either: Predicate.or(
    (n: number) => n > 10,
    (n: number) => n < -10,
  )(a),
  neither: Predicate.not((n: number) => n > 0)(a),
  mapped: Predicate.mapInput(
    (n: number) => n > 0,
    (pair: { n: number }) => pair.n,
  )({ n: a }),
  isString: Predicate.isString(a),
  isBoolean: Predicate.isBoolean(flag),
  isNullish: Predicate.isNullish(null),
  isNotNull: Predicate.isNotNull(a),
  isUndefined: Predicate.isUndefined(undefined),
  isTagged: Predicate.isTagged(Shape.Dot(), "Dot"),
  hasProperty: Predicate.hasProperty({ a }, "a"),
  identity: identity(a),
  constant: constant(a)(),
  constTrue: constTrue(),
  flow: flow(Number.increment, Number.multiply(2))(a),
  tupled: tupled((x: number, y: number) => x - y)([a, b]),
  dualFirst: add(a, b),
  dualLast: pipe(a, add(b)),
});

const ranked = (a: number, b: number, flag: boolean) => ({
  orderNumber: Order.Number(a, b),
  orderMax: Order.max(Order.Number)(a, b),
  orderMin: Order.min(Order.Number)(a, b),
  orderClamp: Order.clamp(Order.Number)(a, { minimum: 0, maximum: 3 }),
  orderBetween: Order.isBetween(Order.Number)(a, { minimum: 0, maximum: 3 }),
  orderLess: Order.isLessThan(Order.Number)(a, b),
  orderAtLeast: Order.isGreaterThanOrEqualTo(Order.Number)(a, b),
  orderFlipped: Order.flip(Order.Number)(a, b),
  orderMapped: Order.mapInput(Order.Number, (pair: { n: number }) => pair.n)({ n: a }, { n: b }),
  orderCombined: Order.combine(
    Order.mapInput(Order.Boolean, (n: number) => n > 0),
    Order.Number,
  )(a, b),
  orderBoolean: Order.Boolean(flag, a > 0),
  // Two values an order says nothing between: which of them is given is the library's choice.
  minOfEqual: Order.min(byN)({ n: a, from: "self" }, { n: b, from: "that" }),
  maxOfEqual: Order.max(byN)({ n: a, from: "self" }, { n: b, from: "that" }),
  clampOfEqual: Order.clamp(byN)(
    { n: a, from: "self" },
    { minimum: { n: 0, from: "least" }, maximum: { n: 3, from: "most" } },
  ),
  orderString: Order.String("a", "b"),
  equal: Equal.equals({ a, list: [b] }, { a: b, list: [a] }),
  shape: Shape.$match(a > 0 ? Shape.Line({ length: a }) : Shape.Dot(), {
    Dot: () => 0,
    Line: ({ length }) => length,
  }),
  isLine: Shape.$is("Line")(Shape.Line({ length: 1 })),
});

const spelled = (text: string, other: string) => ({
  // Each side of these is a path of its own, so the strings the solver picks differ.
  kind: text.startsWith("ab")
    ? text.length > 3
      ? "long"
      : "short"
    : text.includes("b")
      ? "holds"
      : other.endsWith("z")
        ? "ends"
        : "none",
  length: String.length(text),
  isEmpty: String.isEmpty(text),
  isNonEmpty: String.isNonEmpty(text),
  concat: String.concat(text, "-x"),
  startsWith: String.startsWith("ab")(text),
  endsWith: pipe(text, String.endsWith(other)),
  includes: String.includes("b")(text),
  methodStarts: text.startsWith(other),
  methodEnds: text.endsWith("z"),
  methodIncludes: text.includes(other),
  slice: text.slice(1, 3),
  sliceFrom: text.slice(2),
  takeLeft: String.takeLeft(text, 2),
  charAt: text.charAt(0),
  indexOf: text.indexOf("b"),
  optionIndex: String.indexOf("b")(text),
  replace: text.replace("a", "A"),
  replaceAll: text.replaceAll("a", "A"),
  template: `${text}:${other.length}`,
  upper: String.toUpperCase("abc"),
  trim: String.trim("  a "),
  capitalize: String.capitalize("abc"),
  split: String.split("a,b", ","),
  padStart: "7".padStart(3, "0"),
  repeat: "ab".repeat(2),
  isString: String.isString(text),
});

const ordered = (items: ReadonlyArray<number>, a: number) => ({
  sort: Array.sort(items, Order.Number),
  sortDown: Array.sort(items, Order.flip(Order.Number)),
  sortWith: Array.sortWith(items, (n) => -n, Order.Number),
  sortBy: pipe(
    items,
    Array.sortBy(
      Order.mapInput(Order.Number, (n: number) => n % 2),
      Order.Number,
    ),
  ),
  min: Array.isReadonlyArrayNonEmpty(items) ? Array.min(items, Order.Number) : a,
  max: Array.isReadonlyArrayNonEmpty(items) ? Array.max(items, Order.Number) : a,
});

const sliced = (items: ReadonlyArray<number>) => ({
  take: Array.take(items, 1),
  takeRight: Array.takeRight(items, 1),
  drop: Array.drop(items, 1),
  dropRight: Array.dropRight(items, 1),
  takeWhile: Array.takeWhile(items, (n) => n > 0),
  dropWhile: Array.dropWhile(items, (n) => n > 0),
  span: Array.span(items, (n) => n > 0),
  splitAt: Array.splitAt(items, 1),
  chunksOf: Array.chunksOf(items, 1),
  reverse: Array.reverse(items),
});

const combined = (items: ReadonlyArray<number>, a: number) => ({
  zip: Array.zip(items, ["x", "y", "z"]),
  zipWith: Array.zipWith(items, [1, 2, 3], (x, y) => x * y),
  unzip: Array.unzip(Array.zip(items, items)),
  cartesian: Array.cartesian(items, [a]),
  partition: Array.partition(items, halved),
  filterMap: Array.filterMap(items, halved),
  separate: Array.separate(Array.map(items, halved)),
  getSomes: Array.getSomes(Array.map(items, (n) => (n > 0 ? Option.some(n) : Option.none()))),
});

const joined = (items: ReadonlyArray<number>, a: number) => ({
  // The function is given the item, then one already kept.
  dedupeWith: Array.dedupeWith(items, (item, kept) => item > kept),
  union: Array.union(items, [a, 1]),
  intersection: Array.intersection(items, [a, 1]),
  difference: Array.difference(items, [a]),
  join: Array.join(
    Array.map(items, (n) => `${n}`),
    "+",
  ),
  flatten: Array.flatten([items, [a]]),
  dedupe: Array.dedupe(items),
  contains: Array.contains(items, a),
});

const searched = (items: ReadonlyArray<number>, a: number) => ({
  tail: Array.tail(items),
  init: Array.init(items),
  findFirst: Array.findFirst(items, (n) => n > a),
  findFirstOption: Array.findFirst(items, (n) => (n > a ? Option.some(n * 2) : Option.none())),
  findLast: Array.findLast(items, (n) => n > a),
  findFirstIndex: Array.findFirstIndex(items, (n) => n > a),
  countBy: Array.countBy(items, (n) => n > a),
  reduceRight: Array.reduceRight(items, 0, (total, n) => total - n),
  scan: Array.scan(items, 0, (total, n) => total + n),
  mapAccum: Array.mapAccum(items, 0, (total, n) => [total + n, n * 2] as const),
});

const changed = (items: ReadonlyArray<number>, a: number) => ({
  insertAt: Array.insertAt(items, 1, a),
  modify: Array.modify(items, 0, (n) => n + 1),
  replace: Array.replace(items, 0, a),
  remove: Array.remove(items, 0),
  prependAll: Array.prependAll(items, [a]),
  intersperse: Array.intersperse(items, 0),
  groupBy: Array.groupBy(items, (n) => (n > 0 ? "up" : "down")),
  match: Array.match(items, { onEmpty: () => a, onNonEmpty: (all) => all.length }),
  matchLeft: Array.matchLeft(items, { onEmpty: () => a, onNonEmpty: (head) => head }),
  range: Array.range(1, 3),
  makeBy: Array.makeBy(2, (i) => i * a),
  replicate: Array.replicate(a, 2),
  of: Array.of(a),
  fromOption: Array.fromOption(Option.some(a)),
  ensure: Array.ensure(a),
});

const kept = (items: ReadonlyArray<number>, a: number) => ({
  method: {
    join: items.join("|"),
    indexOf: items.indexOf(a),
    flat: [items, [a]].flat(),
    toReversed: items.toReversed(),
    findLast: items.findLast((n) => n > a) ?? null,
  },
  chunk: Chunk.toReadonlyArray(Chunk.map(Chunk.fromIterable(items), (n) => n + 1)),
  record: {
    filter: Record.filter({ a, b: 1 }, (n) => n > 0),
    mapKeys: Record.mapKeys({ a }, (key) => `${key}!`),
    reduce: Record.reduce({ a, b: 2 }, 0, (total, n) => total + n),
    every: Record.every({ a, b: 2 }, (n) => n > 0),
    some: Record.some({ a, b: -2 }, (n) => n > 0),
    union: Record.union({ a }, { a: 1, b: 2 }, (x, y) => x + y),
    intersection: Record.intersection({ a, c: 3 }, { a: 1, b: 2 }, (x, y) => x * y),
    toEntries: Record.toEntries({ a }),
    fromEntries: Record.fromEntries([["k", a]]),
    collect: Record.collect({ a }, (key, n) => `${key}${n}`),
    modify: Record.modify({ a }, "a", (n) => n + 1),
    pop: Record.pop({ a, b: 2 }, "a"),
    findFirst: Record.findFirst({ a, b: 2 }, (n) => n > 1),
    fromIterableBy: Record.fromIterableBy(["x", "y"], (key) => key),
    getSomes: Record.getSomes({ a: Option.some(a), b: Option.none() }),
    singleton: Record.singleton("a", a),
  },
  struct: {
    evolve: Struct.evolve({ a, b: 1 }, { a: (n) => n + 1 }),
    get: Struct.get({ a }, "a"),
    assign: Struct.assign({ a }, { b: 2 }),
    keys: Struct.keys({ a, b: 1 }),
    tuple: Tuple.appendElement(Tuple.make(a, "x"), true),
    tupleGet: Tuple.get(Tuple.make(a, "x"), 1),
  },
});

const weighed = (a: number, maybe: Option.Option<number>) => ({
  all: Option.all([maybe, Option.some(a)]),
  allStruct: Option.all({ a: maybe, b: Option.some(a) }),
  andThen: Option.andThen(maybe, (n) => n + 1),
  tap: Option.tap(maybe, (n) => (n > a ? Option.some(n) : Option.none())),
  contains: Option.contains(maybe, a),
  orElseSome: Option.orElseSome(maybe, () => a),
  toArray: Option.toArray(maybe),
  zipWith: Option.zipWith(maybe, Option.some(a), (x, y) => x + y),
  product: Option.product(maybe, Option.some(a)),
  firstSomeOf: Option.firstSomeOf([Option.none(), maybe, Option.some(a)]),
  liftPredicate: Option.liftPredicate(a, (n) => n > 0),
  flatten: Option.flatten(Option.some(maybe)),
  gen: Option.gen(function* () {
    const n = yield* maybe;
    const m = yield* Option.liftPredicate(a, (x) => x > 0);
    return n + m;
  }),
  result: {
    map: Result.map(halved(a), (n) => n + 1),
    mapError: Result.mapError(halved(a), (error) => `${error}!`),
    flatMap: Result.flatMap(halved(a), halved),
    andThen: Result.andThen(halved(a), (n) => n * 3),
    match: Result.match(halved(a), { onFailure: (error) => error.length, onSuccess: (n) => n }),
    getOrElse: Result.getOrElse(halved(a), () => -1),
    orElse: Result.orElse(halved(a), () => Result.succeed(0)),
    merge: Result.merge(halved(a)),
    flip: Result.flip(halved(a)),
    isSuccess: Result.isSuccess(halved(a)),
    getSuccess: Result.getSuccess(halved(a)),
    getFailure: Result.getFailure(halved(a)),
    fromOption: Result.fromOption(maybe, () => "none"),
    filterOrFail: Result.filterOrFail(
      halved(a),
      (n) => n > 0,
      () => "small",
    ),
    liftPredicate: Result.liftPredicate(
      a,
      (n) => n > 0,
      (n) => `no ${n}`,
    ),
    all: Result.all([halved(a), Result.succeed(1)]),
    gen: Result.gen(function* () {
      const n = yield* halved(a);
      const m = yield* halved(n);
      return n + m;
    }),
  },
});

const priced = (amount: BigDecimal.BigDecimal, a: number, wait: Duration.Duration) => {
  const fee = BigDecimal.fromStringUnsafe("2.5");
  return {
    sum: BigDecimal.sum(amount, fee),
    subtract: BigDecimal.subtract(amount, fee),
    multiply: BigDecimal.multiply(amount, fee),
    negate: BigDecimal.negate(amount),
    abs: BigDecimal.abs(amount),
    min: BigDecimal.min(amount, fee),
    max: BigDecimal.max(amount, fee),
    clamp: BigDecimal.clamp(amount, { minimum: BigDecimal.fromNumberUnsafe(0), maximum: fee }),
    between: BigDecimal.between(amount, { minimum: BigDecimal.fromNumberUnsafe(0), maximum: fee }),
    less: BigDecimal.isLessThan(amount, fee),
    atLeast: BigDecimal.isGreaterThanOrEqualTo(amount, fee),
    equals: BigDecimal.equals(amount, fee),
    isZero: BigDecimal.isZero(amount),
    isPositive: BigDecimal.isPositive(amount),
    isNegative: BigDecimal.isNegative(amount),
    sign: BigDecimal.sign(amount),
    fromNumber: BigDecimal.fromNumberUnsafe(a),
    sumAll: BigDecimal.sumAll([amount, fee, BigDecimal.fromNumberUnsafe(a)]),
    floor: BigDecimal.floor(amount),
    ceil: BigDecimal.ceil(amount),
    truncate: BigDecimal.truncate(amount),
    divide: BigDecimal.divide(fee, BigDecimal.fromNumberUnsafe(2)),
    format: BigDecimal.format(fee),
    equal: Equal.equals(BigDecimal.sum(amount, fee), BigDecimal.sum(fee, amount)),
    order: BigDecimal.Order(amount, fee),
    wait: {
      times: Duration.times(wait, 2),
      isZero: Duration.isZero(wait),
      isNegative: Duration.isNegative(wait),
      abs: Duration.abs(wait),
      negate: Duration.negate(wait),
      clamp: Duration.clamp(wait, { minimum: Duration.zero, maximum: Duration.minutes(1) }),
      between: Duration.between(wait, { minimum: Duration.zero, maximum: Duration.minutes(1) }),
      order: Duration.Order(wait, Duration.seconds(1)),
      longest: Order.max(Duration.Order)(wait, Duration.seconds(1)),
      at: DateTime.addDuration(DateTime.makeUnsafe(0), wait),
      made: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      earlier: DateTime.Order(DateTime.makeUnsafe(a), DateTime.makeUnsafe(0)),
    },
  };
};

const gathered = (members: HashSet.HashSet<number>, a: number) => ({
  size: HashSet.size(members),
  has: HashSet.has(members, a),
  add: HashSet.add(members, a),
  remove: HashSet.remove(members, a),
  union: HashSet.union(members, HashSet.make(a, 1)),
  intersection: HashSet.intersection(members, HashSet.make(a, 1)),
  difference: HashSet.difference(members, HashSet.make(a)),
  isSubset: HashSet.isSubset(HashSet.make(a), members),
});

const membered = (members: HashSet.HashSet<number>, a: number) => ({
  map: HashSet.map(members, (n) => (n > 0 ? 1 : 0)),
  filter: HashSet.filter(members, (n) => n > a),
  some: HashSet.some(members, (n) => n > a),
  every: HashSet.every(members, (n) => n > a),
  total: HashSet.reduce(members, 0, (sum, n) => sum + n),
  isEmpty: HashSet.isEmpty(members),
  equal: Equal.equals(HashSet.add(members, a), HashSet.union(HashSet.make(a), members)),
  sortedItems: Array.sort(Array.fromIterable(members), Order.Number),
});

const tallied = (scores: HashMap.HashMap<string, number>, a: number) => ({
  size: HashMap.size(scores),
  has: HashMap.has(scores, "a"),
  get: HashMap.get(scores, "a"),
  set: HashMap.set(scores, "a", a),
  remove: HashMap.remove(scores, "a"),
  modify: HashMap.modify(scores, "a", (n) => n + 1),
  modifyAt: HashMap.modifyAt(scores, "b", (held) =>
    Option.isSome(held) ? Option.none() : Option.some(a),
  ),
  union: HashMap.union(scores, HashMap.make(["a", a])),
  map: HashMap.map(scores, (n, key) => n + key.length),
  filter: HashMap.filter(scores, (n) => n > a),
  some: HashMap.some(scores, (n) => n > a),
  every: HashMap.every(scores, (n) => n > a),
  total: HashMap.reduce(scores, 0, (sum, n) => sum + n),
  isEmpty: HashMap.isEmpty(scores),
  made: HashMap.fromIterable([
    ["x", a],
    ["x", 2],
  ]),
  sortedValues: Array.sort(HashMap.toValues(scores), Order.Number),
});

const poured = (items: ReadonlyArray<number>, a: number) =>
  Effect.gen(function* () {
    const stream = Stream.fromIterable(items);
    return {
      collect: yield* Stream.runCollect(stream),
      map: yield* stream.pipe(
        Stream.map((n, i) => n * 2 + i),
        Stream.runCollect,
      ),
      filter: yield* stream.pipe(
        Stream.filter((n) => n > a),
        Stream.runCollect,
      ),
      take: yield* stream.pipe(Stream.take(1), Stream.runCollect),
      takeWhile: yield* stream.pipe(
        Stream.takeWhile((n) => n > a),
        Stream.runCollect,
      ),
      takeUntil: yield* stream.pipe(
        Stream.takeUntil((n) => n > a),
        Stream.runCollect,
      ),
      drop: yield* stream.pipe(Stream.drop(1), Stream.runCollect),
      dropWhile: yield* stream.pipe(
        Stream.dropWhile((n) => n > a),
        Stream.runCollect,
      ),
      takeRight: yield* stream.pipe(Stream.takeRight(1), Stream.runCollect),
      concat: yield* stream.pipe(Stream.concat(Stream.make(a, 1)), Stream.runCollect),
      prepend: yield* stream.pipe(Stream.prepend([a]), Stream.runCollect),
      flatMap: yield* stream.pipe(
        Stream.flatMap((n) => Stream.make(n, n + 1)),
        Stream.runCollect,
      ),
      zip: yield* stream.pipe(Stream.zip(Stream.make("x", "y")), Stream.runCollect),
      zipWith: yield* Stream.zipWith(stream, Stream.range(1, 5), (x, y) => x * y).pipe(
        Stream.runCollect,
      ),
      zipWithIndex: yield* stream.pipe(Stream.zipWithIndex, Stream.runCollect),
      scan: yield* stream.pipe(
        Stream.scan(
          () => 0,
          (total, n) => total + n,
        ),
        Stream.runCollect,
      ),
      mapAccum: yield* stream.pipe(
        Stream.mapAccum(
          () => 0,
          (total, n) => [total + n, [total, n]] as const,
        ),
        Stream.runCollect,
      ),
      changes: yield* Stream.make(a, a, 1, 1, a).pipe(Stream.changes, Stream.runCollect),
      grouped: yield* Stream.make(1, 2, a, 4, 5).pipe(Stream.grouped(2), Stream.runCollect),
      mapEffect: yield* stream.pipe(Stream.mapEffect(positive), Stream.runCollect, Effect.result),
      tap: yield* stream.pipe(Stream.tap(even), Stream.take(1), Stream.runCollect, Effect.result),
      filterEffect: yield* stream.pipe(
        Stream.filterEffect((n) => Effect.map(even(n), (m) => m > a)),
        Stream.take(1),
        Stream.runCollect,
        Effect.result,
      ),
      caught: yield* stream.pipe(
        Stream.mapEffect(even),
        Stream.catchTag("Odd", (error) => Stream.make(-error.n)),
        Stream.runCollect,
      ),
      orElse: yield* stream.pipe(
        Stream.mapEffect(positive),
        Stream.orElseSucceed(() => 0),
        Stream.runCollect,
      ),
      mapError: yield* stream.pipe(
        Stream.mapEffect(even),
        Stream.mapError((error) => error.n),
        Stream.runCollect,
        Effect.result,
      ),
      fold: yield* stream.pipe(
        Stream.runFold(
          () => a,
          (total, n) => total + n,
        ),
      ),
      foldEffect: yield* stream.pipe(
        Stream.runFoldEffect(
          () => 0,
          (total, n) => Effect.map(positive(n), (m) => total + m),
        ),
        Effect.result,
      ),
      head: yield* Stream.runHead(stream),
      last: yield* Stream.runLast(stream),
      count: yield* Stream.runCount(stream),
      sum: yield* Stream.runSum(stream),
      text: yield* Stream.make("a", "b").pipe(Stream.mkString),
      iterate: yield* Stream.iterate(a, (n) => n + 2).pipe(Stream.take(3), Stream.runCollect),
      unfold: yield* Stream.unfold(1, (n) =>
        Effect.succeed(n < 4 ? ([n * a, n + 1] as const) : undefined),
      ).pipe(Stream.runCollect),
      paginate: yield* Stream.paginate(0, (page) =>
        Effect.succeed([[page, a], page < 2 ? Option.some(page + 1) : Option.none()] as const),
      ).pipe(Stream.runCollect),
      range: yield* Stream.range(1, 3).pipe(Stream.runCollect),
      fromEffect: yield* Stream.fromEffect(Effect.succeed(a)).pipe(Stream.runCollect),
      suspend: yield* Stream.suspend(() => Stream.make(a)).pipe(Stream.runCollect),
      empty: yield* Stream.runCollect(Stream.empty),
      drain: yield* stream.pipe(Stream.drain, Stream.runCollect),
    };
  });

const ran = (a: number, b: number) =>
  Effect.gen(function* () {
    return {
      as: yield* Effect.as(Effect.succeed(a), b),
      zip: yield* Effect.zip(Effect.succeed(a), Effect.succeed(b)),
      zipWith: yield* Effect.succeed(a).pipe(Effect.zipWith(Effect.succeed(b), (x, y) => x - y)),
      all: yield* Effect.all([Effect.succeed(a), Effect.succeed(b)]),
      allStruct: yield* Effect.all({ a: Effect.succeed(a), b: Effect.succeed(b) }),
      forEach: yield* Effect.forEach([a, b], (n, i) => Effect.succeed(n + i)),
      reduce: yield* Effect.reduce(
        [a, b],
        () => 1,
        (total, n) => Effect.succeed(total + n),
      ),
      filter: yield* Effect.filter([a, b], (n) => Effect.succeed(n > 0)),
      findFirst: yield* Effect.findFirst([a, b], (n) => Effect.succeed(n > 0)),
      partition: yield* Effect.partition([a, b], even),
      caught: yield* even(a).pipe(Effect.catch((error) => Effect.succeed(-error.n))),
      catchTag: yield* even(a).pipe(Effect.catchTag("Odd", () => Effect.succeed(0))),
      catchTags: yield* Effect.flatMap(even(a), positive).pipe(
        Effect.catchTags({
          Odd: () => Effect.succeed(1),
          Negative: (error) => Effect.succeed(error.n * 2),
        }),
      ),
      catchIf: yield* even(a).pipe(
        Effect.catchIf(
          (error) => error.n > 0,
          () => Effect.succeed(0),
        ),
        Effect.result,
      ),
      mapError: yield* even(a).pipe(
        Effect.mapError((error) => error.n),
        Effect.result,
      ),
      mapBoth: yield* even(a).pipe(
        Effect.mapBoth({ onFailure: (error) => error.n, onSuccess: (n) => `${n}` }),
        Effect.result,
      ),
      orElseSucceed: yield* even(a).pipe(Effect.orElseSucceed(() => 0)),
      tapError: yield* even(a).pipe(
        Effect.tapError(() => Effect.void),
        Effect.option,
      ),
      match: yield* Effect.match(even(a), { onFailure: () => "odd", onSuccess: () => "even" }),
      matchEffect: yield* Effect.matchEffect(even(a), {
        onFailure: (error) => Effect.succeed(error.n),
        onSuccess: positive,
      }).pipe(Effect.result),
      ignore: yield* Effect.ignore(even(a)),
      isSuccess: yield* Effect.isSuccess(even(a)),
      flip: yield* Effect.flip(even(a)).pipe(Effect.option),
      filterOrFail: yield* Effect.succeed(a).pipe(
        Effect.filterOrFail(
          (n) => n > b,
          (n) => `small ${n}`,
        ),
        Effect.result,
      ),
      when: yield* Effect.succeed(a).pipe(Effect.when(Effect.succeed(a > b))),
      fromOption: yield* Effect.fromOption(a > 0 ? Option.some(a) : Option.none()).pipe(
        Effect.catchNoSuchElement,
      ),
      fromResult: yield* Effect.fromResult(halved(a)).pipe(Effect.result),
      ensuring: yield* even(a).pipe(Effect.ensuring(Effect.void), Effect.option),
      bound: yield* Effect.Do.pipe(
        Effect.bind("x", () => Effect.succeed(a)),
        Effect.let("y", ({ x }) => x + b),
      ),
      suspend: yield* Effect.suspend(() => Effect.succeed(a)),
      asSome: yield* Effect.asSome(Effect.succeed(a)),
      died: yield* even(a).pipe(
        Effect.orDie,
        // A defect is not a failure: nothing here catches it.
        Effect.catch(() => Effect.succeed(-1)),
        Effect.when(Effect.succeed(a % 2 === 0)),
      ),
    };
  });

const extra = (a: number, b: number) =>
  Effect.gen(function* () {
    const twice = Effect.fn(
      function* (n: number) {
        return yield* even(n);
      },
      Effect.map((n) => n * 2),
      Effect.orElseSucceed(() => -1),
    );
    return {
      fnWithSteps: yield* twice(a),
      tapErrorTag: yield* even(a).pipe(
        Effect.tapErrorTag("Odd", () => Effect.void),
        Effect.option,
      ),
      filterOrElse: yield* Effect.succeed(a).pipe(
        Effect.filterOrElse(
          (n) => n > b,
          (n) => Effect.succeed(-n),
        ),
      ),
      succeedNone: yield* Effect.succeedNone,
      succeedSome: yield* Effect.succeedSome(a),
      failSync: yield* Effect.failSync(() => a).pipe(Effect.flip),
      flatten: yield* Effect.flatten(Effect.succeed(Effect.succeed(a))),
      bindTo: yield* Effect.succeed(a).pipe(Effect.bindTo("a")),
      runSync: Effect.runSync(Effect.succeed(a + b)),
      fromNullishOr: yield* Effect.fromNullishOr(a > 0 ? a : null).pipe(Effect.option),
      isFailure: yield* Effect.isFailure(positive(a)),
      ref: yield* Effect.gen(function* () {
        const total = yield* Ref.make(a);
        yield* Ref.update(total, (n) => n + b);
        const before = yield* total.pipe(Ref.getAndUpdate((n) => n * 2));
        const taken = yield* Ref.modify(total, (n) => [n - 1, n + 1] as const);
        yield* Ref.set(total, (yield* Ref.get(total)) + 1);
        return {
          before,
          taken,
          after: yield* Ref.get(total),
          swapped: yield* Ref.getAndSet(total, 0),
        };
      }),
      exit: yield* Effect.gen(function* () {
        const ended = yield* Effect.exit(even(a));
        const dead = yield* Effect.exit(Effect.orDie(positive(a)));
        return {
          isSuccess: Exit.isSuccess(ended),
          matched: Exit.match(ended, {
            onSuccess: (n) => n,
            onFailure: (cause) => (Cause.hasFails(cause) ? -1 : -2),
          }),
          error: Exit.findErrorOption(ended),
          value: Exit.getSuccess(Exit.map(ended, (n) => n + 1)),
          mapped: Exit.findErrorOption(Exit.mapError(ended, (error) => error.n)),
          died: Exit.hasDies(dead),
          failed: Exit.hasFails(dead),
          made: Exit.isFailure(Exit.fail("no")),
          squashed: Cause.squash(Cause.fail(a)),
          again: yield* Effect.failCause(Cause.fail(a)).pipe(Effect.flip),
        };
      }),
      rational: {
        sum: Rational.sum(third, Rational.fromBigInt(BigInt(a))),
        multiply: Rational.multiply(third, Rational.fromBigInt(BigInt(a))),
        divide: Rational.divide(Rational.fromBigInt(BigInt(a)), Rational.fromBigInt(BigInt(b))),
        made: Rational.make(BigInt(a), BigInt(b)),
        less: Rational.isLessThan(Rational.fromBigInt(BigInt(a)), third),
        equals: Rational.equals(
          Rational.multiply(Rational.fromBigInt(BigInt(a)), third),
          Rational.makeUnsafe(BigInt(a), 3n),
        ),
        min: Rational.min(third, Rational.fromBigInt(BigInt(b))),
        sign: Rational.sign(Rational.subtract(Rational.fromBigInt(BigInt(a)), third)),
        isInteger: Rational.isInteger(Rational.makeUnsafe(BigInt(a), 2n)),
        sumAll: Rational.sumAll([third, third, Rational.fromBigInt(BigInt(a))]),
        format: Rational.format(Rational.sum(third, third)),
        fromDecimal: Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("0.25")),
        order: Rational.Order(third, Rational.fromBigInt(BigInt(a))),
      },
      mutable: (() => {
        const count = MutableRef.make(a);
        MutableRef.update(count, (n) => n + b);
        MutableRef.increment(count);
        const before = MutableRef.getAndSet(count, MutableRef.get(count) * 2);
        const seen = MutableHashSet.make(a);
        MutableHashSet.add(seen, b);
        const scores = MutableHashMap.make(["a", a]);
        MutableHashMap.set(scores, "b", b);
        MutableHashMap.modify(scores, "a", (n) => n + 1);
        MutableHashMap.remove(scores, "missing");
        return {
          before,
          after: MutableRef.get(count),
          next: MutableRef.incrementAndGet(count),
          seen: MutableHashSet.size(seen),
          has: MutableHashSet.has(seen, a),
          a: MutableHashMap.get(scores, "a"),
          b: MutableHashMap.get(scores, "b"),
          size: MutableHashMap.size(scores),
        };
      })(),
      hidden: Redacted.value(Redacted.make(a)),
      filters: {
        fromPredicate: Filter.fromPredicate((n: number) => n > b)(a),
        toOption: Filter.toOption(Filter.fromPredicate((n: number) => n > b))(a),
        toPredicate: Filter.toPredicate(Filter.fromPredicate((n: number) => n > b))(a),
        equals: Filter.equals(b)(a),
        tagged: Filter.tagged("Dot")(Shape.Dot()),
      },
      ordering: {
        reverse: Ordering.reverse(Order.Number(a, b)),
        match: Ordering.match(Order.Number(a, b), {
          onLessThan: () => "less",
          onEqual: () => "equal",
          onGreaterThan: () => "more",
        }),
      },
      undefinedOr: {
        map: UndefinedOr.map(a > 0 ? a : undefined, (n) => n + 1) ?? "nothing",
        match: UndefinedOr.match(a > b ? a : undefined, {
          onUndefined: () => 0,
          onDefined: (n) => n * 2,
        }),
      },
      option: {
        as: Option.as(Option.some(a), b),
        asVoid: Option.asVoid(Option.some(a)),
        zipLeft: Option.zipLeft(Option.some(a), a > b ? Option.some(b) : Option.none()),
        zipRight: Option.zipRight(Option.some(a), Option.some(b)),
        flatMapNullishOr: Option.flatMapNullishOr(Option.some(a), (n) => (n > 0 ? n : null)),
        isOption: Option.isOption(a),
        getSuccess: Option.getSuccess(halved(a)),
        getFailure: Option.getFailure(halved(a)),
      },
      result: {
        tap: Result.tap(halved(a), () => undefined),
        mapBoth: Result.mapBoth(halved(a), {
          onFailure: (error) => error.length,
          onSuccess: (n) => `${n}`,
        }),
        getOrNull: Result.getOrNull(halved(a)),
        getOrUndefined: Result.getOrUndefined(halved(a)) ?? "nothing",
        fromNullishOr: Result.fromNullishOr(a > 0 ? a : null, () => "nothing"),
        isResult: Result.isResult(halved(a)),
        succeedSome: Result.succeedSome(a),
      },
      functions: {
        compose: pipe(
          (n: number) => n + 1,
          compose((n: number) => n * 2),
        )(a),
        apply: apply(a)((n: number) => n - 1),
        untupled: untupled((pair: readonly [number, number]) => pair[0] - pair[1])(a, b),
        flip: flip((x: number) => (y: number) => x - y)(a)(b),
        strict: Equivalence.strictEqual<number>()(a, b),
        mappedSame: Equivalence.mapInput(Equivalence.strictEqual<number>(), (n: number) => n % 2)(
          a,
          b,
        ),
        isTruthy: Predicate.isTruthy(a),
        xor: Predicate.xor(
          (n: number) => n > 0,
          (n: number) => n > 5,
        )(a),
        bigClamp: BigInts.clamp(BigInt(a), { minimum: -2n, maximum: 2n }),
        bigBetween: BigInts.between(BigInt(a), { minimum: -2n, maximum: 2n }),
        bigMin: BigInts.min(BigInt(a), BigInt(b)),
        bigIncrement: BigInts.increment(BigInt(a)),
        bigRemainder: BigInts.remainder(BigInt(a), 3n),
      },
    };
  });

const rest = (items: ReadonlyArray<number>, a: number) => ({
  findLastIndex: Array.findLastIndex(items, (n) => n > a),
  cartesianWith: Array.cartesianWith(items, [a, 1], (x, y) => x - y),
  getSuccesses: Array.getSuccesses(Array.map(items, halved)),
  getFailures: Array.getFailures(Array.map(items, halved)),
  flatMapNullishOr: Array.flatMapNullishOr(items, (n) => (n > a ? n : null)),
  matchRight: Array.matchRight(items, { onEmpty: () => a, onNonEmpty: (_init, last) => last }),
  unprepend: Array.isReadonlyArrayNonEmpty(items) ? Array.unprepend(items) : null,
  unappend: Array.isReadonlyArrayNonEmpty(items) ? Array.unappend(items) : null,
  headNonEmpty: Array.isReadonlyArrayNonEmpty(items) ? Array.headNonEmpty(items) : a,
  lastNonEmpty: Array.isReadonlyArrayNonEmpty(items) ? Array.lastNonEmpty(items) : a,
  tailNonEmpty: Array.isReadonlyArrayNonEmpty(items) ? Array.tailNonEmpty(items) : [],
  copy: Array.copy(items),
  fromNullishOr: Array.fromNullishOr(a > 0 ? a : null),
  fromRecord: Array.fromRecord({ a }),
  isArray: Array.isArray(items),
  getUnsafe: Array.getUnsafe(Array.append(items, a), 0),
  record: {
    mapEntries: Record.mapEntries({ a }, (n, key) => [`${key}2`, n + 1]),
    difference: Record.difference({ a, b: 1 }, { b: 2, c: 3 }),
    replace: Record.replace({ a }, "a", 0),
    partition: Record.partition({ a, b: 2 }, halved),
    filterMap: Record.filterMap({ a, b: 2 }, halved),
    fromIterableWith: Record.fromIterableWith(["x", "y"], (key) => [key, a]),
    renameKeys: Struct.renameKeys({ a, b: 1 }, { a: "c" }),
    appendElements: Tuple.appendElements(Tuple.make(a), ["x", true]),
  },
  map: {
    setMany: HashMap.setMany(HashMap.make(["a", 1]), [
      ["a", a],
      ["b", 2],
    ]),
    removeMany: HashMap.removeMany(HashMap.make(["a", 1], ["b", a]), ["a"]),
    filterMap: HashMap.filterMap(HashMap.make(["a", a]), halved),
    compact: HashMap.compact(HashMap.make(["a", Option.some(a)], ["b", Option.none()])),
    findFirst: HashMap.findFirst(HashMap.make(["a", a]), (n) => n > 0),
    keys: Array.fromIterable(HashMap.keys(HashMap.make(["a", a]))),
    entries: Array.fromIterable(HashMap.entries(HashMap.make(["a", a]))),
    getUnsafe: HashMap.getUnsafe(HashMap.make(["a", a]), "a"),
    hasBy: HashMap.hasBy(HashMap.make(["a", a]), (n) => n > 0),
    spread: [...HashSet.make(a)],
  },
});

const flowed = (items: ReadonlyArray<number>, a: number) =>
  Effect.gen(function* () {
    const stream = Stream.fromArray(items);
    const seen: Array<number> = [];
    yield* stream.pipe(Stream.runForEach((n) => Effect.sync(() => void seen.push(n))));
    const some: Array<number> = [];
    yield* stream.pipe(
      Stream.runForEachWhile((n) =>
        Effect.sync(() => {
          some.push(n);
          return n > a;
        }),
      ),
    );
    return {
      seen,
      some,
      changesWith: yield* Stream.make(a, a + 2, 1, 3).pipe(
        Stream.changesWith((x, y) => x % 2 === y % 2),
        Stream.runCollect,
      ),
      rechunk: yield* stream.pipe(Stream.rechunk(1), Stream.runCollect),
      caught: yield* stream.pipe(
        Stream.mapEffect(even),
        Stream.catch((error) => Stream.make(error.n, 0)),
        Stream.runCollect,
      ),
      catchTags: yield* stream.pipe(
        Stream.mapEffect((n) => Effect.flatMap(even(n), positive)),
        Stream.catchTags({
          Odd: () => Stream.make(1),
          Negative: (error) => Stream.make(error.n),
        }),
        Stream.runCollect,
      ),
      catchIf: yield* stream.pipe(
        Stream.mapEffect(even),
        Stream.catchIf(
          (error) => error.n > a,
          () => Stream.make(0),
        ),
        Stream.runCollect,
        Effect.result,
      ),
      groupedThenFails: yield* stream.pipe(
        Stream.mapEffect(positive),
        Stream.grouped(2),
        Stream.runCollect,
        Effect.result,
      ),
      drained: yield* stream.pipe(Stream.runDrain),
      as: yield* stream.pipe(Stream.as(a), Stream.runCollect),
      filterMap: yield* stream.pipe(Stream.filterMap(halved), Stream.runCollect),
      sync: yield* Stream.sync(() => a).pipe(Stream.runCollect),
      unwrap: yield* Stream.unwrap(Effect.succeed(Stream.make(a))).pipe(Stream.runCollect),
      fromArrayEffect: yield* Stream.fromArrayEffect(Effect.succeed([a, 1])).pipe(
        Stream.runCollect,
      ),
      takeUntilExcluded: yield* stream.pipe(
        Stream.takeUntil((n) => n > a, { excludeLast: true }),
        Stream.runCollect,
      ),
      failed: yield* Stream.fail("no").pipe(Stream.runCollect, Effect.result),
    };
  });

/** The parts of the library the prover reads, each run on what a command gives. */
export class Workbench extends Domain.Aggregate("Workbench", {
  id: Schema.String,
  state: Schema.Struct({ runs: Schema.Int }),
  initial: { runs: 0 },
  invariants: { NeverBelowZero: (bench) => bench.runs >= 0 },
  commands: [
    Count,
    Judge,
    Rank,
    Spell,
    Sort,
    Slice,
    Combine,
    Join,
    Search,
    Change,
    Keep,
    Weigh,
    Price,
    Gather,
    Members,
    Tally,
    Pour,
    Run,
    Extra,
    Rest,
    Flow,
  ],
  keyOf: (command) => command.id,
  decide: {
    Count: (_bench, command) => [
      new Worked({ results: counted(command.a, command.b, command.flag) }),
    ],
    Judge: (_bench, command) => [
      new Worked({ results: judged(command.a, command.b, command.flag) }),
    ],
    Rank: (_bench, command) => [
      new Worked({ results: ranked(command.a, command.b, command.flag) }),
    ],
    Spell: (_bench, command) => [new Worked({ results: spelled(command.text, command.other) })],
    Sort: (_bench, command) => [new Worked({ results: ordered(command.items, command.a) })],
    Slice: (_bench, command) => [new Worked({ results: sliced(command.items) })],
    Combine: (_bench, command) => [new Worked({ results: combined(command.items, command.a) })],
    Join: (_bench, command) => [new Worked({ results: joined(command.items, command.a) })],
    Search: (_bench, command) => [new Worked({ results: searched(command.items, command.a) })],
    Change: (_bench, command) => [new Worked({ results: changed(command.items, command.a) })],
    Keep: (_bench, command) => [new Worked({ results: kept(command.items, command.a) })],
    Weigh: (_bench, command) => [new Worked({ results: weighed(command.a, command.maybe) })],
    Price: (_bench, command) => [
      new Worked({ results: priced(command.amount, command.a, command.wait) }),
    ],
    Gather: (_bench, command) => [new Worked({ results: gathered(command.members, command.a) })],
    Members: (_bench, command) => [new Worked({ results: membered(command.members, command.a) })],
    Tally: (_bench, command) => [new Worked({ results: tallied(command.scores, command.a) })],
    Pour: Effect.fn(function* (_bench, command) {
      return [new Worked({ results: yield* poured(command.items, command.a) })];
    }),
    Run: Effect.fn(function* (_bench, command) {
      return [new Worked({ results: yield* ran(command.a, command.b) })];
    }),
    Extra: Effect.fn(function* (_bench, command) {
      return [new Worked({ results: yield* extra(command.a, command.b) })];
    }),
    Rest: (_bench, command) => [new Worked({ results: rest(command.items, command.a) })],
    Flow: Effect.fn(function* (_bench, command) {
      return [new Worked({ results: yield* flowed(command.items, command.a) })];
    }),
  },
  evolve: { Worked: (bench) => ({ runs: bench.runs + 1 }) },
}) {}
