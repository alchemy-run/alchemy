/**
 * The cases every Export store passes. Model-based: generated sequences of
 * writes (fresh, retried, overlapping), rebuilds into a new generation and
 * promotions run against the store and against a reference model kept here
 * in plain arrays; then every read the store offers (`get`, paged `list`,
 * `scan`, `lag`) under Domain filters and orderings must agree with the
 * model. Each evaluation uses a table name of its own, so a store that
 * persists starts fresh.
 */
import * as Domain from "@alchemy.run/domain";
import * as Export from "@alchemy.run/domain/Export";
import * as ExportStore from "@alchemy.run/domain/Export/Store";
import { matches, sort, type Filter, type OrderBy } from "@alchemy.run/domain/Filter";
import { equals } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Registers one case; the caller provides what the store needs (`R`) around it. */
type TestFn<R> = (
  name: string,
  effect: Effect.Effect<void, unknown, R>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) => void;

export interface StoreConformanceOptions<R> {
  readonly test: TestFn<R>;
  /** A store to run one evaluation against. Tables are named per evaluation; it need not be empty. */
  readonly make: Effect.Effect<ExportStore.Implementation, unknown, R>;
  /** Where the store runs: on this machine, or in a cloud. */
  readonly kind: "local" | "live";
  /** Generated sequences per property; fewer for a slow store. */
  readonly runs?: number;
  /**
   * Shrink steps after a falsification; a slow store bounds them so the
   * failure reports inside the case's timeout instead of timing out.
   */
  readonly maxShrinks?: number;
}

// ---------------------------------------------------------------- the table and its rows

class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Int,
  memo: Schema.NullOr(Schema.String),
}) {}
class Withdrew extends Domain.Event("Withdrew", { amount: Schema.Int }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Withdrew],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, { amount }) => [new Deposited({ amount, memo: null })],
    Withdraw: (_, { amount }) => [new Withdrew({ amount })],
  },
  evolve: { Deposited: (s) => s, Withdrew: (s) => s },
}) {}
export class Ledger extends Export.Table(
  "Ledger",
  { from: [Account], key: Account, on: [Deposited, Withdrew] },
  {
    table: "ledger",
    metadata: { _export_memo: Export.Metadata.copy("event.memo", Schema.NullOr(Schema.String)) },
  },
) {}

const base = Date.parse("2026-01-01T00:00:00.000Z");
const keys = ["a1", "a2", "a3"] as const;

/**
 * Memos of the deposits: a null, ASCII, and two that order one way by UTF-16
 * code units (JavaScript) and the other by UTF-8 bytes (SQL's binary order):
 * U+FFFD sorts after a surrogate pair in JavaScript, before it in UTF-8.
 */
const memos = [null, "m2", "\uFFFD", "\u{1F600}"] as const;

/** One row as the table writes it. */
const encodeRow = (
  i: number,
  key: string,
  route: string | undefined,
  stream: string,
  seq: number,
) =>
  Effect.runSync(
    Schema.encodeEffect(Schema.toCodecJson(Ledger.Row))({
      key: { id: key },
      route,
      position: seq,
      envelope: {
        id: `e${i}`,
        stream,
        seq,
        at: DateTime.makeUnsafe(base + i * 1_000),
        commandId: `c${i}`,
        correlationId: `c${i}`,
      },
      event:
        i % 2 === 0
          ? new Deposited({ amount: i * 5, memo: memos[i / 2]! })
          : new Withdrew({ amount: i }),
    }),
  ) as Schema.JsonObject;

/**
 * Ten rows, the pool every sequence draws from: eight events of three keys,
 * withdrawals routed `out`; then one withdrawal delivered again, to another
 * key (`in`), and to its own key by a second route, each its own row.
 */
export const pool: ReadonlyArray<Schema.JsonObject> = [
  ...Array.from({ length: 8 }, (_, i) => {
    const key = keys[i % keys.length]!;
    const seq = Math.floor(i / keys.length) + 1;
    return encodeRow(i, key, i % 2 === 0 ? undefined : "out", `Account/${key}`, seq);
  }),
  encodeRow(1, "a3", "in", "Account/a2", 1),
  encodeRow(1, "a2", "in", "Account/a2", 1),
];

/** One deposit as the table writes it, every value chosen: for properties over what engines bind. */
export const depositRow = (deposit: {
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly amount: number;
  readonly memo: string | null;
}) =>
  Effect.runSync(
    Schema.encodeEffect(Schema.toCodecJson(Ledger.Row))({
      key: { id: deposit.key },
      route: undefined,
      position: deposit.seq,
      envelope: {
        id: `d-${deposit.key}-${deposit.seq}`,
        stream: `Account/${deposit.key}`,
        seq: deposit.seq,
        at: DateTime.makeUnsafe(deposit.at),
        commandId: `d${deposit.seq}`,
        correlationId: `d${deposit.seq}`,
      },
      event: new Deposited({ amount: deposit.amount, memo: deposit.memo }),
    }),
  ) as Schema.JsonObject;

/** The model's identity rule, kept apart from the store's: key, route, and the event's place in its stream. */
const identityOf = (row: Schema.JsonObject) => {
  const envelope = row["envelope"] as Schema.JsonObject;
  return {
    key: row["key"],
    route: row["route"] ?? null,
    stream: envelope["stream"],
    seq: envelope["seq"],
  };
};
const sameIdentity = (a: Schema.JsonObject, b: Schema.JsonObject) =>
  equals(identityOf(a), identityOf(b));
/** The identity a reader is asked `get` with, for a row of the pool. */
const lookupOf = (row: Schema.JsonObject): ExportStore.Identity => {
  const { key, route, stream, seq } = identityOf(row);
  return {
    key: String(key),
    route: typeof route === "string" ? route : undefined,
    stream: String(stream),
    seq: Number(seq),
  };
};

/** Reads checked after every sequence: Domain filters over the row and its metadata, and orderings. */
const filters: ReadonlyArray<Filter<Schema.JsonObject> | undefined> = [
  undefined,
  { key: "a1" },
  { event: { _tag: "Deposited" } },
  { event: { amount: { gte: 10 } } },
  { OR: [{ key: "a2" }, { position: { gt: 2 } }] },
  { _export_memo: null },
  { NOT: { _export_memo: null } },
  // A comparison with a nullable column under NOT: a null memo is "not m2".
  { NOT: { _export_memo: "m2" } },
  { _export_memo: { startsWith: "m" } },
  { _export_memo: { gt: "\u{1F600}" } },
  { key: { in: ["a1", "a3"] } },
  { position: { notIn: [1] } },
  { envelope: { at: { lt: new Date(base + 3_000).toISOString() } } },
] as ReadonlyArray<Filter<Schema.JsonObject> | undefined>;
const orders: ReadonlyArray<OrderBy<Schema.JsonObject> | undefined> = [
  undefined,
  { key: "asc" },
  { position: "desc" },
  { _export_lag_ms: "asc" },
];

/** Nearest-rank lag quantiles, computed here rather than with the store's own `summarizeLag`. */
const lagOf = (rows: ReadonlyArray<Schema.JsonObject>) => {
  const lags = rows
    .map((row) => row["_export_lag_ms"])
    .filter((lag): lag is number => typeof lag === "number");
  const sorted = [...lags].sort((a, b) => a - b);
  const rank = (q: number) =>
    sorted.length === 0 ? null : (sorted[Math.ceil(q * sorted.length) - 1] ?? sorted[0]!);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1) ?? null,
  };
};

// ---------------------------------------------------------------- the reference model

/** What a store holds: per generation, rows in the order they were first written; and what is promoted. */
export interface Model {
  readonly generations: ReadonlyArray<Array<Schema.JsonObject>>;
  promoted: number | undefined;
}

const modelWrite = (
  model: Model,
  generation: number,
  rows: ReadonlyArray<Schema.JsonObject>,
  run: Export.Metadata.Run,
) => {
  const table = model.generations[generation]!;
  const source =
    model.promoted === undefined || model.promoted === generation
      ? undefined
      : model.generations[model.promoted];
  for (const row of rows) {
    if (table.some((held) => sameIdentity(held, row))) continue;
    const previous = source?.find((held) => sameIdentity(held, row));
    table.push({ ...row, ...Export.Metadata.evaluate(Ledger.spec.metadata, row, run, previous) });
  }
};

/** What a reader of `generation`'s spec sees: the promoted generation, or its own before any promotion. */
export const modelVisible = (model: Model, generation: number) =>
  model.generations[model.promoted ?? generation]!;

// ---------------------------------------------------------------- generated sequences

export const Op = Schema.Union([
  Schema.TaggedStruct("Write", {
    generation: Schema.Literals([0, 1]),
    rows: Schema.Array(Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
    after: Schema.Int,
  }),
  Schema.TaggedStruct("Promote", { generation: Schema.Literals([0, 1]) }),
]);
export const ops = Arbitrary.schema(Schema.Array(Op));

/** Sequences long enough to race against, each with a promotion (a swap readers can straddle). */
export const raceOps = Arbitrary.array(Arbitrary.schema(Op), { minLength: 6, maxLength: 14 }).pipe(
  Arbitrary.filter((sequence) => sequence.some((op) => op._tag === "Promote")),
);

/** A copy of the model at one moment: a race checks answers against past states. */
const snapshot = (model: Model): Model => ({
  generations: model.generations.map((rows) => [...rows]),
  promoted: model.promoted,
});

/** One read made while the writer ran: the last state settled when it began and when it ended. */
export interface RaceRead<A> {
  readonly start: number;
  readonly end: number;
  readonly value: A;
}

/**
 * Run `sequence` against the store (as `applySequence`) while `readers`
 * fibers repeat `read` until the writer finishes. Returns every state the
 * store settled in (after the generations exist, then after each step) and
 * every read with the states it spanned. A failed read fails the race.
 */
export const race = <A, E, R>(options: {
  readonly store: ExportStore.Implementation;
  readonly name: string;
  readonly sequence: ReadonlyArray<typeof Op.Type>;
  readonly read: Effect.Effect<A, E, R>;
  readonly readers?: number;
}) =>
  Effect.gen(function* () {
    const states: Array<Model> = [];
    const settled = yield* Ref.make(-1);
    const ready = yield* Deferred.make<void>();
    const done = yield* Ref.make(false);
    const reads: Array<RaceRead<A>> = [];
    const reader = Effect.gen(function* () {
      yield* Deferred.await(ready);
      while (!(yield* Ref.get(done))) {
        const start = yield* Ref.get(settled);
        const value = yield* options.read;
        reads.push({ start, end: yield* Ref.get(settled), value });
      }
    });
    const fibers = yield* Effect.forkChild(
      Effect.all(
        Array.from({ length: options.readers ?? 2 }, () => reader),
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    );
    yield* applySequence(options.store, options.name, options.sequence, (model, step) =>
      Effect.gen(function* () {
        states.push(snapshot(model));
        yield* Ref.set(settled, states.length - 1);
        if (step === -1) yield* Deferred.succeed(ready, undefined);
      }),
    ).pipe(Effect.ensuring(Ref.set(done, true)));
    yield* Fiber.join(fibers);
    return { states, reads };
  });

/**
 * Every answer a read spanning `start..end` could give: the generation
 * visible at some state it spanned (or the step in flight as it ended),
 * holding the rows of that state or any later one it spanned, since writes
 * continue under a read. Answers are compared as JSON.
 */
export const answersDuring = <B>(
  states: ReadonlyArray<Model>,
  start: number,
  end: number,
  answer: (model: Model) => B,
): ReadonlySet<string> => {
  const last = Math.min(end + 1, states.length - 1);
  const allowed = new Set<string>();
  for (let i = Math.max(start, 0); i <= last; i++) {
    const live = states[i]!.promoted ?? 0;
    for (let j = i; j <= last; j++)
      allowed.add(JSON.stringify(answer({ generations: states[j]!.generations, promoted: live })));
  }
  return allowed;
};

/** A read that disagrees with the model: a falsification the checker shrinks. */
class Disagrees extends Error {}

export const agree = (what: string, actual: unknown, expected: unknown) =>
  equals(actual, expected)
    ? Effect.void
    : Effect.fail(
        new Disagrees(
          `${what}\n  store: ${JSON.stringify(actual)}\n  model: ${JSON.stringify(expected)}`,
        ),
      );

export const fresh = () => `ledger_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** Every page of a list, following its cursor. */
const allPages = (reader: ExportStore.RawReader, request: ExportStore.ReadRequest, take: number) =>
  Effect.gen(function* () {
    const rows: Array<ExportStore.EncodedRow> = [];
    let after: string | undefined;
    for (let page = 0; page <= pool.length; page++) {
      const { entries, cursor } = yield* reader.list(request, { after, take });
      rows.push(...entries);
      if (cursor === null) return rows;
      after = cursor;
    }
    return yield* Effect.fail(new Disagrees(`list with take ${take} never ended`));
  });

/**
 * Ensure both generations of the table under `name`, then run the sequence
 * against the store and the model alike. `after`, if given, runs once the
 * generations exist (step -1) and after each step, with the model as it
 * then stands.
 */
export const applySequence = <E = never, R = never>(
  store: ExportStore.Implementation,
  name: string,
  sequence: ReadonlyArray<typeof Op.Type>,
  after?: (model: Model, step: number) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const specs = [0, 1].map((generation): Export.Spec.TableSpec => ({
      ...Ledger.spec,
      name,
      generation,
    }));
    const targets = specs.map((spec) => store.target(spec));
    const model: Model = { generations: [[], []], promoted: undefined };
    for (const [i, spec] of specs.entries()) yield* targets[i]!.ensure(spec);
    if (after !== undefined) yield* after(model, -1);
    for (const [step, op] of sequence.entries()) {
      if (op._tag === "Promote") {
        yield* targets[op.generation]!.promote(specs[op.generation]!);
        model.promoted = op.generation;
      } else {
        const rows = op.rows.map((i) => pool[i]!);
        const run = {
          ingestedAt: DateTime.makeUnsafe(base + 10_000 + step * 1_000 + Math.abs(op.after)),
        };
        yield* targets[op.generation]!.write(specs[op.generation]!, {
          rows,
          ingestedAt: run.ingestedAt,
        });
        modelWrite(model, op.generation, rows, run);
      }
      if (after !== undefined) yield* after(model, step);
    }
    return { specs, model };
  });

const runSequence = <R>(
  make: StoreConformanceOptions<R>["make"],
  sequence: ReadonlyArray<typeof Op.Type>,
) =>
  Effect.gen(function* () {
    const store = yield* make;
    const { specs, model } = yield* applySequence(store, fresh(), sequence);
    const readers = specs.map((spec) => store.reader(spec));
    for (const [generation, reader] of readers.entries()) {
      const visible = modelVisible(model, generation);
      for (const row of pool) {
        const held = visible.find((candidate) => sameIdentity(candidate, row));
        yield* agree(
          `get ${JSON.stringify(identityOf(row))} (generation ${generation})`,
          Option.getOrUndefined(yield* reader.get(lookupOf(row))),
          held,
        );
      }
      for (const where of filters) {
        for (const orderBy of orders) {
          const expected = sort(
            visible.filter((row) => matches(where, row)),
            orderBy,
          );
          const request = { where, orderBy };
          const label = `where ${JSON.stringify(where)} orderBy ${JSON.stringify(orderBy)} (generation ${generation})`;
          yield* agree(
            `scan ${label}`,
            [...(yield* Stream.runCollect(reader.scan(request)))],
            expected,
          );
          yield* agree(`list by 3 ${label}`, yield* allPages(reader, request, 3), expected);
        }
        yield* agree(
          `lag where ${JSON.stringify(where)} (generation ${generation})`,
          yield* reader.lag({ where }),
          lagOf(visible.filter((row) => matches(where, row))),
        );
      }
    }
    return true;
  }).pipe(Effect.provide(RuntimeContext.phantom));

// ---------------------------------------------------------------- the cases

export const storeConformance = <R = never>({
  test,
  make,
  kind,
  runs = 60,
  maxShrinks,
}: StoreConformanceOptions<R>) => {
  const options = { timeout: 120_000, tags: [kind] };

  test(
    "every read agrees with the model after any sequence of writes, retries, rebuilds and promotions",
    Arbitrary.checkEffect(ops, (sequence) => runSequence(make, sequence), {
      runs,
      maxShrinks,
      seed: "export-store-conformance",
    }).pipe(
      Effect.flatMap((result) =>
        result._tag === "Passed"
          ? Effect.void
          : Effect.fail(new Error(Arbitrary.formatCheckFailure(result))),
      ),
    ),
    options,
  );

  // Generated sequences retry an identity only once they grow past their first few runs; a
  // slow store runs few. This one always does: a run delivered again in part, then rebuilt.
  test(
    "a write retried in part keeps the first row of each identity, before and after a rebuild",
    runSequence(make, [
      { _tag: "Write", generation: 0, rows: [0, 1, 2, 8], after: 0 },
      { _tag: "Write", generation: 0, rows: [2, 3, 8, 9], after: 5 },
      { _tag: "Write", generation: 1, rows: [0, 2, 9], after: 2 },
      { _tag: "Promote", generation: 1 },
      { _tag: "Write", generation: 1, rows: [0, 2, 3, 9], after: 7 },
    ]).pipe(Effect.asVoid),
    options,
  );

  // A slow store runs few generated sequences, and few of them promote twice. This one always
  // does: a rebuild promoted, then the first generation promoted back, which must win.
  test(
    "a second promotion moves readers again, to a generation promoted before",
    runSequence(make, [
      { _tag: "Write", generation: 0, rows: [0, 1, 2, 3], after: 0 },
      { _tag: "Write", generation: 1, rows: [0, 1, 4, 5], after: 1 },
      { _tag: "Promote", generation: 1 },
      { _tag: "Promote", generation: 0 },
      { _tag: "Write", generation: 0, rows: [6, 7], after: 2 },
    ]).pipe(Effect.asVoid),
    options,
  );

  test(
    "ensure is idempotent, and refuses another table under the same generation",
    Effect.gen(function* () {
      const store = yield* make;
      const spec: Export.Spec.TableSpec = { ...Ledger.spec, name: fresh() };
      const target = store.target(spec);
      yield* target.ensure(spec);
      yield* target.ensure(spec);
      const drift = yield* Effect.flip(
        target.ensure({ ...spec, fingerprint: `${spec.fingerprint}!` }),
      );
      if (drift._tag !== "SchemaDrift")
        return yield* Effect.fail(new Error(`expected SchemaDrift, got ${drift._tag}`));
      // Another generation of the same table is its own table.
      yield* target.ensure({ ...spec, generation: 1, fingerprint: `${spec.fingerprint}!` });
    }).pipe(Effect.provide(RuntimeContext.phantom)),
    options,
  );
};
