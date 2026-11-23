import * as Domain from "@alchemy.run/domain";
import * as Array from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as BigInts from "effect/BigInt";
import * as Boolean from "effect/Boolean";
import * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Chunk from "effect/Chunk";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Exit from "effect/Exit";
import * as Filter from "effect/Filter";
import {
  absurd,
  cast,
  constFalse,
  constNull,
  constUndefined,
  constVoid,
  satisfies,
} from "effect/Function";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as MutableRef from "effect/MutableRef";
import * as Number from "effect/Number";
import * as Optic from "effect/Optic";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rational from "effect/Rational";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as String from "effect/String";
import * as UndefinedOr from "effect/UndefinedOr";

// The rest of what the prover reads of the library, each run on what a
// command gives, as `Workbench` does for the first part.

const Small = Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }));

export class Turned extends Domain.Event("Turned", { results: Schema.Unknown }) {}

const Numbers = { id: Schema.String, a: Small, b: Small };
const Items = { id: Schema.String, items: Schema.Array(Small), a: Small };

export class Figure extends Domain.Command("Figure", { input: Numbers, events: [Turned] }) {}
export class Letter extends Domain.Command("Letter", {
  input: { id: Schema.String, text: Schema.String, a: Small },
  events: [Turned],
}) {}
export class Choose extends Domain.Command("Choose", {
  input: { id: Schema.String, a: Small, maybe: Schema.NullOr(Small) },
  events: [Turned],
}) {}
export class Gather extends Domain.Command("Gather", { input: Items, events: [Turned] }) {}
export class Time extends Domain.Command("Time", {
  input: { id: Schema.String, at: Schema.DateTimeUtc, wait: Schema.Duration, a: Small },
  events: [Turned],
}) {}
export class Cell extends Domain.Command("Cell", { input: Numbers, events: [Turned] }) {}
export class Counter extends Domain.RequestContext<Counter>()(
  "Lathe/Counter",
  Schema.Struct({ start: Small }),
) {}
export class Desk extends RpcMiddleware.Service<Desk, { provides: Counter }>()("Lathe/Desk") {}
export class Act extends Domain.Command("Act", {
  input: Numbers,
  events: [Turned],
  middleware: [Desk],
}) {}
export class Flow extends Domain.Command("Flow", { input: Items, events: [Turned] }) {}
export class Build extends Domain.Command("Build", { input: Numbers, events: [Turned] }) {}
export class Long extends Domain.Command("Long", { input: Numbers, events: [Turned] }) {}

/** A class of `effect/Data` a file exports: the prover makes its instances from the class itself. */
export class Point extends Data.Class<{ readonly x: number; readonly y: number }> {}
export class Circle extends Data.TaggedClass("Circle")<{ readonly radius: number }> {}
export class Unfit extends Data.TaggedError("Unfit")<{ readonly by: number }> {}
export class Plain extends Data.Error<{ readonly code: number }> {}

/** A class of `effect/Schema`: its fields are checked as its schema says. */
export class Receipt extends Schema.Class<Receipt>("Receipt")({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  note: Schema.String,
}) {}
export class Square extends Schema.TaggedClass<Square>()("Square", { side: Schema.Int }) {}
export class Refused extends Schema.TaggedError<Refused>()("Refused", { why: Schema.String }) {}

type Meters = number & Brand.Brand<"Meters">;
const Meters = Brand.nominal<Meters>();

const figured = (a: number, b: number) => ({
  bigSubtract: BigInts.subtract(BigInt(a), BigInt(b)),
  bigDecrement: BigInts.decrement(BigInt(a)),
  bigDivideUnsafe: BigInts.divideUnsafe(BigInt(a), 3n),
  bigMore: BigInts.isGreaterThan(BigInt(a), BigInt(b)),
  bigAtLeast: BigInts.isGreaterThanOrEqualTo(BigInt(a), BigInt(b)),
  bigAtMost: BigInts.isLessThanOrEqualTo(BigInt(a), BigInt(b)),
  bigSumAll: BigInts.sumAll([BigInt(a), 2n]),
  bigMultiplyAll: BigInts.multiplyAll([BigInt(a), 2n]),
  bigOrder: BigInts.Order(BigInt(a), BigInt(b)),
  bigSame: BigInts.Equivalence(BigInt(a), BigInt(b)),
  bigLcm: BigInts.lcm(4n, 6n),
  bigSqrt: BigInts.sqrt(16n),
  bigFromNumber: BigInts.fromNumber(7),
  bigFromString: BigInts.fromString("12"),
  isBigInt: BigInts.isBigInt(BigInt(a)),
  divideUnsafe: Number.divideUnsafe(a * 4, 4),
  order: Number.Order(a, b),
  same: Number.Equivalence(a, b),
  orderBig: Order.BigInt(BigInt(a), BigInt(b)),
  orderMore: Order.isGreaterThan(Order.Number)(a, b),
  orderAtMost: Order.isLessThanOrEqualTo(Order.Number)(a, b),
  orderMade: Order.make<number>((x, y) => (x < y ? -1 : x > y ? 1 : 0))(a, b),
  sameMade: Equivalence.make<number>((x, y) => x % 2 === y % 2)(a, b),
  sameNumber: Equivalence.Number(a, b),
  sameString: Equivalence.String("a", "a"),
  sameBoolean: Equivalence.Boolean(a > 0, b > 0),
  sameBigInt: Equivalence.BigInt(BigInt(a), BigInt(b)),
  boolOrder: Boolean.Order(a > 0, b > 0),
  boolSame: Boolean.Equivalence(a > 0, b > 0),
  isBoolean: Boolean.isBoolean(a > 0),
  isNumber: Predicate.isNumber(a),
  isBigIntP: Predicate.isBigInt(a),
  isFunction: Predicate.isFunction(figuredNothing),
  isNull: Predicate.isNull(null),
  isNotNullish: Predicate.isNotNullish(a),
  isNotUndefined: Predicate.isNotUndefined(a),
  constFalse: constFalse(),
  constNull: constNull(),
  constUndefined: constUndefined() ?? "undefined",
  constVoid: constVoid() ?? "void",
  cast: cast<number, number>(a),
  satisfied: satisfies<number>()(a),
  meters: Meters(a),
  decimal: {
    fromBigInt: BigDecimal.fromBigInt(BigInt(a)),
    fromNumber: BigDecimal.fromNumber(a),
    fromString: BigDecimal.fromString("1.25"),
    made: BigDecimal.make(125n, 2),
    isBigDecimal: BigDecimal.isBigDecimal(BigDecimal.fromNumberUnsafe(a)),
    more: BigDecimal.isGreaterThan(BigDecimal.fromNumberUnsafe(a), BigDecimal.fromNumberUnsafe(b)),
    isInteger: BigDecimal.isInteger(BigDecimal.fromNumberUnsafe(a)),
    multiplyAll: BigDecimal.multiplyAll([
      BigDecimal.fromNumberUnsafe(a),
      BigDecimal.fromStringUnsafe("0.5"),
    ]),
    normalized: BigDecimal.normalize(BigDecimal.fromNumberUnsafe(a)),
    divided: BigDecimal.divideUnsafe(
      BigDecimal.fromStringUnsafe("1.5"),
      BigDecimal.fromStringUnsafe("0.5"),
    ),
    scaled: BigDecimal.scale(BigDecimal.fromStringUnsafe("1.5"), 3),
    asNumber: BigDecimal.toNumberUnsafe(BigDecimal.fromStringUnsafe("1.5")),
  },
  rational: {
    abs: Rational.abs(Rational.fromBigInt(BigInt(a))),
    negate: Rational.negate(Rational.makeUnsafe(BigInt(a), 3n)),
    between: Rational.between(Rational.fromBigInt(BigInt(a)), {
      minimum: Rational.fromBigInt(0n),
      maximum: Rational.makeUnsafe(7n, 2n),
    }),
    clamp: Rational.clamp(Rational.fromBigInt(BigInt(a)), {
      minimum: Rational.fromBigInt(0n),
      maximum: Rational.makeUnsafe(7n, 2n),
    }),
    max: Rational.max(Rational.fromBigInt(BigInt(a)), Rational.makeUnsafe(1n, 2n)),
    more: Rational.isGreaterThan(Rational.fromBigInt(BigInt(a)), Rational.makeUnsafe(1n, 2n)),
    atLeast: Rational.isGreaterThanOrEqualTo(
      Rational.fromBigInt(BigInt(a)),
      Rational.makeUnsafe(1n, 2n),
    ),
    atMost: Rational.isLessThanOrEqualTo(
      Rational.fromBigInt(BigInt(a)),
      Rational.makeUnsafe(1n, 2n),
    ),
    isNegative: Rational.isNegative(Rational.fromBigInt(BigInt(a))),
    isPositive: Rational.isPositive(Rational.fromBigInt(BigInt(a))),
    isZero: Rational.isZero(Rational.fromBigInt(BigInt(a))),
    isRational: Rational.isRational(Rational.fromBigInt(1n)),
    multiplyAll: Rational.multiplyAll([
      Rational.makeUnsafe(1n, 2n),
      Rational.fromBigInt(BigInt(a)),
    ]),
    fromNumber: Rational.fromNumber(a),
    fromNumberUnsafe: Rational.fromNumberUnsafe(a),
    fromString: Rational.fromString("3/4"),
    fromStringUnsafe: Rational.fromStringUnsafe("3/4"),
    asNumber: Rational.toNumberUnsafe(Rational.makeUnsafe(1n, 4n)),
    half:
      b === 0
        ? null
        : Rational.divideUnsafe(Rational.fromBigInt(BigInt(a)), Rational.fromBigInt(BigInt(b))),
  },
});

function figuredNothing() {}

const lettered = (text: string, a: number) => ({
  kind: text.startsWith("ab")
    ? text.includes("z")
      ? "abz"
      : "ab"
    : text.length > 2
      ? "long"
      : "short",
  slice: text.slice(1, 3),
  substring: text.substring(1, 2),
  charAt: String.charAt(1)(text),
  replace: String.replace("a", "o")(text),
  replaceAll: String.replaceAll("a", "o")(text),
  sliced: String.slice(1)(text),
  substringOf: String.substring(0, 2)(text),
  same: String.Equivalence(text, "ab"),
  order: String.Order("a", "b"),
  empty: String.empty,
  at: String.at(0)("abc"),
  lastIndexOf: String.lastIndexOf("b")("abcb"),
  padEnd: String.padEnd(4, "-")("ab"),
  padStart: String.padStart(4, "-")("ab"),
  repeat: String.repeat(2)("ab"),
  takeRight: String.takeRight("abcd", 2),
  lower: String.toLowerCase("ABC"),
  trimEnd: String.trimEnd(" a "),
  trimStart: String.trimStart(" a "),
  uncapitalize: String.uncapitalize("Abc"),
  matched: Match.value({
    _tag: a > 0 ? "Up" : "Down",
    kind: a > 5 ? "big" : "small",
    n: a,
  } as const).pipe(
    Match.withReturnType<string>(),
    Match.whenAnd({ kind: "big" }, { _tag: "Up" }, () => "big up"),
    Match.whenOr({ n: 0 }, { n: 1 }, () => "tiny"),
    Match.tags({ Down: () => "down", Up: () => "up" }),
    Match.orElseAbsurd,
  ),
  discriminated: Match.value({ kind: a > 0 ? "up" : "down", n: a } as const).pipe(
    Match.discriminator("kind")("up", () => "u"),
    Match.discriminators("kind")({ down: () => "d" }),
    Match.option,
  ),
  exhaustive: Match.value({ kind: a > 0 ? "up" : "down" } as const).pipe(
    Match.discriminatorsExhaustive("kind")({ up: () => 1, down: () => 2 }),
  ),
  typed: Match.typeTags<{ _tag: "A"; n: number } | { _tag: "B" }>()({
    A: ({ n }) => n,
    B: () => 0,
  })(a > 0 ? { _tag: "A", n: a } : { _tag: "B" }),
  patterns: Match.value(a > 0 ? a : null).pipe(
    Match.when(Match.defined, (n) => `n${n}`),
    Match.when(Match.any, () => "nothing"),
    Match.exhaustive,
  ),
});

const chosen = (a: number, maybe: number | null) => {
  const option = Option.fromNullOr(maybe);
  return {
    fromNullish: Option.fromNullishOr(maybe),
    fromUndefined: Option.fromUndefinedOr(maybe ?? undefined),
    filter: Option.filter(option, (n) => n > a),
    flatMap: Option.flatMap(option, (n) => (n > a ? Option.some(n - a) : Option.none())),
    getOrNull: Option.getOrNull(option),
    getOrUndefined: Option.getOrUndefined(option) ?? "nothing",
    orElse: Option.orElse(option, () => Option.some(a)),
    isNone: Option.isNone(option),
    getOrThrow: Option.isSome(option) ? Option.getOrThrow(option) : a,
    getOrThrowWith: Option.isSome(option) ? Option.getOrThrowWith(option, () => "none") : a,
    resultThrow: Result.getOrThrow(Result.succeed(a)),
    resultThrowWith: Result.getOrThrowWith(Result.succeed(a), () => "no"),
    failVoid: Result.isFailure(Result.failVoid),
    succeedNone: Result.succeedNone,
    orThrow: UndefinedOr.getOrThrow(a),
    hidden: Redacted.isRedacted(Redacted.make(a)),
    filterMade: Filter.make((n: number) => (n > a ? Result.succeed(n) : Result.fail(n)))(
      maybe ?? 0,
    ),
    filterResult: Filter.toResult(Filter.fromPredicate((n: number) => n > a))(maybe ?? 0),
    optic: Optic.id<{ readonly n: number }>().key("n").replace(a, { n: 0 }),
    opticModify: Optic.id<{ readonly n: number }>()
      .key("n")
      .modify((n) => n + a)({ n: 1 }),
  };
};

const gathered = (items: ReadonlyArray<number>, a: number) => ({
  appendAll: Array.appendAll(items, [a]),
  prepend: Array.prepend(items, a),
  empty: Array.empty<number>(),
  made: Array.make(a, 1),
  flatMap: Array.flatMap(items, (n) => [n, n + a]),
  get: Array.get(items, 0),
  some: Array.some(items, (n) => n > a),
  reduce: Array.reduce(items, 0, (total, n) => total + n),
  isEmpty: Array.isArrayEmpty(items as Array<number>),
  isReadonlyEmpty: Array.isReadonlyArrayEmpty(items),
  init: Array.isReadonlyArrayNonEmpty(items) ? Array.initNonEmpty(items) : [],
  seen: (() => {
    const out: Array<number> = [];
    Array.forEach(items, (n) => out.push(n));
    return out;
  })(),
  chunkSize: Chunk.size(Chunk.fromIterable(items)),
  chunkEmpty: Chunk.isEmpty(Chunk.fromIterable(items)),
  chunkNonEmpty: Chunk.isNonEmpty(Chunk.fromIterable(items)),
  iterableSize: Iterable.size(items),
  iterableEmpty: Iterable.isEmpty(items),
  record: {
    empty: Record.empty<string, number>(),
    get: Record.get({ a }, "a"),
    missing: Record.get({ a } as Record<string, number>, "b"),
    set: Record.set({ a }, "b", 1),
    remove: Record.remove({ a, b: 1 }, "a"),
    map: Record.map({ a }, (n) => n + 1),
    keys: Record.keys({ a, b: 1 }),
    values: Record.values({ a, b: 1 }),
    size: Record.size({ a }),
    isEmpty: Record.isEmptyRecord({}),
    isReadonlyEmpty: Record.isEmptyReadonlyRecord({ a }),
  },
  hash: {
    fromIterable: HashSet.fromIterable([a, 1, a]),
    isHashSet: HashSet.isHashSet(HashSet.make(a)),
    isHashMap: HashMap.isHashMap(HashMap.make(["a", a])),
    values: Array.sort(
      Array.fromIterable(HashMap.values(HashMap.make(["a", a], ["b", 1]))),
      Order.Number,
    ),
    entries: HashMap.toEntries(HashMap.make(["a", a])),
    each: (() => {
      const out: Array<number> = [];
      HashMap.forEach(HashMap.make(["a", a]), (n) => void out.push(n));
      return out;
    })(),
  },
});

const timed = (at: DateTime.Utc, wait: Duration.Duration, a: number) => ({
  between: DateTime.between(at, {
    minimum: DateTime.makeUnsafe(0),
    maximum: DateTime.makeUnsafe(1_000_000),
  }),
  less: DateTime.isLessThan(at, DateTime.makeUnsafe(0)),
  max: DateTime.max(at, DateTime.makeUnsafe(0)),
  min: DateTime.min(at, DateTime.makeUnsafe(0)),
  subtract: DateTime.subtract(at, { minutes: a }),
  same: DateTime.Equivalence(at, DateTime.makeUnsafe(0)),
  made: DateTime.make(a),
  date: DateTime.formatIsoDate(DateTime.makeUnsafe("2026-03-04T05:06:07Z")),
  dateUtc: DateTime.formatIsoDateUtc(DateTime.makeUnsafe("2026-03-04T05:06:07Z")),
  sum: Duration.sum(wait, Duration.hours(1)),
  subtracted: Duration.subtract(wait, Duration.millis(5)),
  max_: Duration.max(wait, Duration.weeks(1)),
  min_: Duration.min(wait, Duration.zero),
  less_: Duration.isLessThan(wait, Duration.seconds(1)),
  atMost: Duration.isLessThanOrEqualTo(wait, Duration.seconds(1)),
  more: Duration.isGreaterThan(wait, Duration.seconds(1)),
  atLeast: Duration.isGreaterThanOrEqualTo(wait, Duration.seconds(1)),
  positive: Duration.isPositive(wait),
  finite: Duration.isFinite(wait),
  same_: Duration.Equivalence(wait, Duration.zero),
  millis: Duration.toMillis(wait),
  seconds: Duration.toSeconds(Duration.minutes(a)),
  minutes: Duration.toMinutes(Duration.hours(2)),
  hours: Duration.toHours(Duration.days(1)),
  days: Duration.toDays(Duration.weeks(1)),
  weeks: Duration.toWeeks(Duration.days(14)),
});

const celled = (a: number, b: number) => {
  const count = MutableRef.make(a);
  MutableRef.set(count, a + b);
  MutableRef.decrement(count);
  const flag = MutableRef.make(a > b);
  MutableRef.toggle(flag);
  const set = MutableHashSet.fromIterable([a, b]);
  MutableHashSet.remove(set, b);
  const emptySet = MutableHashSet.empty<number>();
  MutableHashSet.add(emptySet, a);
  MutableHashSet.clear(emptySet);
  const map = MutableHashMap.fromIterable([["a", a] as const]);
  MutableHashMap.modifyAt(map, "b", () => Option.some(b));
  const none = MutableHashMap.empty<string, number>();
  MutableHashMap.set(none, "x", a);
  MutableHashMap.clear(none);
  const cell = Ref.makeUnsafe(a);
  return {
    setAndGet: MutableRef.setAndGet(count, a),
    updateAndGet: MutableRef.updateAndGet(count, (n) => n + 1),
    getAndUpdate: MutableRef.getAndUpdate(count, (n) => n * 2),
    decrementAndGet: MutableRef.decrementAndGet(count),
    getAndDecrement: MutableRef.getAndDecrement(count),
    getAndIncrement: MutableRef.getAndIncrement(count),
    count: MutableRef.get(count),
    flag: MutableRef.get(flag),
    setSize: MutableHashSet.size(set),
    emptySize: MutableHashSet.size(emptySet),
    has: MutableHashMap.has(map, "b"),
    keys: Array.sort(Array.fromIterable(MutableHashMap.keys(map)), Order.String),
    values: Array.sort(Array.fromIterable(MutableHashMap.values(map)), Order.Number),
    isEmpty: MutableHashMap.isEmpty(none),
    held: Ref.getUnsafe(cell),
  };
};

const acted = (a: number, b: number) =>
  Effect.gen(function* () {
    const cell = yield* Ref.make(a);
    const ended = yield* Effect.exit(Effect.die("gone"));
    return {
      andThen: yield* Effect.succeed(a).pipe(Effect.andThen((n) => Effect.succeed(n + b))),
      tap: yield* Effect.succeed(a).pipe(Effect.tap(() => Effect.log("seen"))),
      asVoid: (yield* Effect.asVoid(Effect.succeed(a))) ?? "void",
      untraced: yield* Effect.fnUntraced(function* (n: number) {
        return n * 2;
      })(a),
      logged: yield* Effect.succeed(a).pipe(
        Effect.withSpan("lathe"),
        Effect.annotateLogs("a", a),
        Effect.annotateSpans("b", b),
        Effect.withLogSpan("turn"),
      ),
      yielded: (yield* Effect.yieldNow) ?? "yielded",
      nanos: (yield* Clock.currentTimeNanos) >= 0n,
      service: (yield* Effect.service(Counter)).start,
      provided: yield* Effect.service(Counter).pipe(
        Effect.provideService(Counter, { start: a }),
        Effect.map((counter) => counter.start),
      ),
      setAndGet: yield* Ref.setAndGet(cell, b),
      updateAndGet: yield* Ref.updateAndGet(cell, (n) => n + 1),
      died: Exit.hasDies(ended),
      cause: Option.isSome(Exit.getCause(ended)),
      noError: Cause.findErrorOption(Cause.die("x")),
      causeDies: Cause.hasDies(Cause.die("x")),
      exit: Exit.getSuccess(Exit.asVoid(Exit.succeed(a))),
      exitDied: Exit.isFailure(Exit.die("x")),
    };
  });

const flowed = (items: ReadonlyArray<number>, a: number) =>
  Effect.gen(function* () {
    const seen: Array<number> = [];
    yield* Stream.run(
      Stream.fromIterable(items),
      Sink.forEach((n: number) => Effect.sync(() => void seen.push(n))),
    );
    return {
      seen,
      succeed: yield* Stream.succeed(a).pipe(Stream.withSpan("flow"), Stream.runCollect),
      fromEffect: yield* Stream.fromIterableEffect(Effect.succeed(items)).pipe(Stream.runCollect),
      died: yield* Stream.fromIterable(items).pipe(
        Stream.mapEffect((n) => (n > a ? Effect.fail("big") : Effect.succeed(n))),
        Stream.orDie,
        Stream.runCollect,
        Effect.exit,
        Effect.map(Exit.hasDies),
      ),
      dead: yield* Stream.die("gone").pipe(
        Stream.runCollect,
        Effect.exit,
        Effect.map(Exit.isFailure),
      ),
      sinkSucceed: yield* Stream.run(Stream.fromIterable(items), Sink.succeed(a)),
      sinkFail: yield* Stream.run(Stream.fromIterable(items), Sink.fail("no")).pipe(Effect.result),
    };
  });

const built = (a: number, b: number) =>
  Effect.gen(function* () {
    const point = new Point({ x: a, y: b });
    const circle = new Circle({ radius: a });
    const square = Square.make({ side: a });
    const receipt = a >= 0 ? new Receipt({ total: a, note: "paid" }) : undefined;
    return {
      x: point.x,
      tag: circle._tag,
      radius: circle.radius,
      samePoint: Data.Class === Data.Class && point.x === new Point({ x: a, y: b }).x,
      side: square.side,
      squareTag: square._tag,
      total: receipt?.total ?? -1,
      note: receipt?.note ?? "none",
      unfit: yield* Effect.fail(new Unfit({ by: a })).pipe(
        Effect.catchTag("Unfit", (error) => Effect.succeed(error.by)),
      ),
      yieldedError: yield* Effect.gen(function* () {
        if (a > b) return yield* new Unfit({ by: a - b });
        return 0;
      }).pipe(Effect.catch((error) => Effect.succeed(-error.by))),
      plain: yield* Effect.fail(new Plain({ code: a })).pipe(
        Effect.catch((error) => Effect.succeed(error.code)),
      ),
      refused: yield* Effect.gen(function* () {
        return yield* new Refused({ why: "no" });
      }).pipe(Effect.catchTag("Refused", (error) => Effect.succeed(error.why))),
    };
  });

/** A stream of more items than one chunk holds: the steps that work a chunk at a time meet the edge of one. */
const long = (a: number, b: number) =>
  Effect.gen(function* () {
    const many = Stream.range(1, 5000);
    const check = (n: number): Effect.Effect<number, string> =>
      n === 4097 + (a > b ? 1 : 0) ? Effect.fail("stop") : Effect.succeed(n);
    return {
      count: yield* Stream.runCount(many),
      // The filter works through the whole first chunk before anything goes on, so the
      // effect at the start of the second chunk never runs.
      filtered: yield* many.pipe(
        Stream.filterEffect((n) => Effect.map(check(n), () => n % 1000 === 0)),
        Stream.take(4),
        Stream.runCollect,
        Effect.result,
      ),
      // Here it does: the fifth is in the second chunk.
      reached: yield* many.pipe(
        Stream.filterEffect((n) => Effect.map(check(n), () => n % 1000 === 0)),
        Stream.take(5),
        Stream.runCollect,
        Effect.result,
      ),
      grouped: yield* many.pipe(
        Stream.rechunk(3000),
        Stream.grouped(2500),
        Stream.map((group) => group.length),
        Stream.runCollect,
      ),
      last: yield* many.pipe(Stream.drop(4090), Stream.take(10), Stream.runCollect),
      taken: yield* many.pipe(Stream.takeRight(2), Stream.runCollect),
    };
  });

/** The rest of the library the prover reads, each run on what a command gives. */
export class Lathe extends Domain.Aggregate("Lathe", {
  id: Schema.String,
  state: Schema.Struct({ turns: Schema.Int }),
  initial: { turns: 0 },
  invariants: { NeverBelowZero: (lathe) => lathe.turns >= 0 },
  commands: [Figure, Letter, Choose, Gather, Time, Cell, Act, Flow, Build, Long],
  keyOf: (command) => command.id,
  decide: {
    Figure: (_lathe, command) => [new Turned({ results: figured(command.a, command.b) })],
    Letter: (_lathe, command) => [new Turned({ results: lettered(command.text, command.a) })],
    Choose: (_lathe, command) => [new Turned({ results: chosen(command.a, command.maybe) })],
    Gather: (_lathe, command) => [new Turned({ results: gathered(command.items, command.a) })],
    Time: (_lathe, command) => [
      new Turned({ results: timed(command.at, command.wait, command.a) }),
    ],
    Cell: (_lathe, command) => [new Turned({ results: celled(command.a, command.b) })],
    Act: Effect.fn(function* (_lathe, command) {
      return [new Turned({ results: yield* acted(command.a, command.b) })];
    }),
    Flow: Effect.fn(function* (_lathe, command) {
      return [new Turned({ results: yield* flowed(command.items, command.a) })];
    }),
    Build: Effect.fn(function* (_lathe, command) {
      return [new Turned({ results: yield* built(command.a, command.b) })];
    }),
    Long: Effect.fn(function* (_lathe, command) {
      return [new Turned({ results: yield* long(command.a, command.b) })];
    }),
  },
  evolve: { Turned: (lathe) => ({ turns: lathe.turns + 1 }) },
}) {}

export const unused = absurd;
