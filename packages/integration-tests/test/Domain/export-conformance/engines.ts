/**
 * The cases every Export engine passes over the store it reads. Model-based,
 * as the store suite: a generated sequence of writes, rebuilds and
 * promotions goes to the store and to the model; then declared queries run
 * on the engine, each answer checked against the same question asked of the
 * model's rows under the table's stable name (the promoted generation, or
 * the first one before any promotion). Then two properties every engine
 * shares: queries racing the writer see only states the store passed
 * through, and every value an engine binds selects what JavaScript's
 * comparison selects.
 */
import * as Export from "@alchemy.run/domain/Export";
import type { Dialect, EngineClass, QueryKey } from "@alchemy.run/domain/Export/Engine";
import type * as ExportStore from "@alchemy.run/domain/Export/Store";
import type { StoreKey } from "@alchemy.run/domain/Export/Store";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  agree,
  answersDuring,
  applySequence,
  depositRow,
  fresh,
  Ledger,
  type Model,
  type Op,
  ops,
  pool,
  race,
  raceOps,
} from "./conformance.ts";

/** The store every engine case reads. */
export class EngineLake extends Export.Store("EngineLake", { tables: [Ledger] }) {}

/** The engine declaration of one dialect. */
export type Analytics = EngineClass<"Analytics", readonly [typeof EngineLake], Dialect>;

type TestFn<R> = (
  name: string,
  effect: Effect.Effect<void, unknown, R>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) => void;

export interface EngineConformanceOptions<R> {
  readonly test: TestFn<R>;
  readonly dialect: Dialect;
  /**
   * The store and engine, built fresh for each evaluation. `name` is the
   * table's physical name in this evaluation, for an engine that names
   * tables; `freshNames: false` keeps the declared name (DuckDB's memory
   * engine loads each table under it, from a store as fresh as itself).
   */
  readonly layer: (
    analytics: Analytics,
    name: () => string,
  ) => Layer.Layer<QueryKey<"Analytics"> | StoreKey<"EngineLake">, unknown, R>;
  readonly freshNames: boolean;
  readonly kind: "local" | "live";
  readonly runs?: number;
  /** Shrink steps after a falsification; see `StoreConformanceOptions.maxShrinks`. */
  readonly maxShrinks?: number;
  /**
   * Whether a read can run while a write is in flight, so the race must
   * catch one spanning a step. A server can; an in-process store on one
   * connection serialises them, and its race checks what each read saw only.
   * @default true
   */
  readonly readsInterleave?: boolean;
}

const base = Date.parse("2026-01-01T00:00:00.000Z");
/**
 * A 64-bit integer as each engine returns it: a number, a `bigint`
 * (DuckDB), or its digits (Postgres, ClickHouse). The queries stay portable
 * SQL (no dialect's cast) and the answer is read as a number here.
 */
const IntLike = Schema.Union([Schema.Number, Schema.BigInt, Schema.String]);
// `account` and `total`, not `key` and `rows`: both are reserved in MySQL 8.
const PerKey = Schema.Struct({ account: Schema.String, total: IntLike });
const Position = Schema.Struct({ account: Schema.String, position: IntLike });
const Count = Schema.Struct({ n: IntLike });
/** The value an engine returned, as it returned it: a schema would parse any text as a date. */
const Latest = Schema.Struct({ account: Schema.String, latest: Schema.Unknown });
/**
 * An instant as an engine may return one without ambiguity: a `Date`, or ISO
 * text with its zone. Anything else (`2026-01-01 00:00:05.123` names no
 * instant) comes back as itself, to fail the comparison.
 */
const instantOf = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)$/.test(value)
      ? new Date(value).toISOString()
      : value;

const text = (row: Schema.JsonObject, field: string) => String(row[field]);
const sorted = <A>(rows: ReadonlyArray<A>) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** The model's answers to the questions every reader of the table is asked. */
export const modelAnswers = (model: Model) => {
  const visible = model.generations[model.promoted ?? 0]!;
  const keys = [...new Set(visible.map((row) => text(row, "key")))].sort();
  return {
    perKey: keys.map((key) => ({
      key,
      rows: visible.filter((row) => text(row, "key") === key).length,
    })),
    positions: sorted(
      visible
        .filter((row) => text(row, "key") === "a2" && Number(row["position"]) >= 1)
        .map((row) => ({ key: "a2", position: Number(row["position"]) })),
    ),
    early: visible.filter(
      (row) => Date.parse(String((row["envelope"] as Schema.JsonObject)["at"])) < base + 3_000,
    ).length,
    noMemo: visible.filter((row) => row["_export_memo"] === null).length,
  };
};

export const engineConformance = <R = never>({
  test,
  dialect,
  layer,
  freshNames,
  kind,
  runs = 40,
  maxShrinks,
  readsInterleave = true,
}: EngineConformanceOptions<R>) => {
  const options = { timeout: 120_000, tags: [kind] };
  const Analytics: Analytics = Export.Engine("Analytics", { stores: [EngineLake], dialect });

  const ask = Effect.gen(function* () {
    const sql = yield* Analytics.Query;
    const perKey = yield* sql.many(PerKey)`
      SELECT ${Ledger.column("key")} AS account, count(*) AS total
      FROM ${Ledger} GROUP BY ${Ledger.column("key")} ORDER BY ${Ledger.column("key")}`;
    const streamed = yield* Stream.runCollect(sql.stream(PerKey)`
      SELECT ${Ledger.column("key")} AS account, count(*) AS total
      FROM ${Ledger} GROUP BY ${Ledger.column("key")} ORDER BY ${Ledger.column("key")}`);
    const positions = yield* sql.many(Position)`
      SELECT ${Ledger.column("key")} AS account, ${Ledger.column("position")} AS position
      FROM ${Ledger} WHERE ${Ledger.column("key")} = ${"a2"} AND ${Ledger.column("position")} >= ${1}`;
    const early = yield* sql.one(Count)`
      SELECT count(*) AS n FROM ${Ledger}
      WHERE ${Ledger.column("envelope.at")} < ${DateTime.makeUnsafe(base + 3_000)}`;
    const noMemo = yield* sql.one(Count)`
      SELECT count(*) AS n FROM ${Ledger}
      WHERE ${Ledger.column("_export_memo")} IS NULL`;
    const perKeyOf = (rows: ReadonlyArray<typeof PerKey.Type>) =>
      rows.map((row) => ({ key: row.account, rows: Number(row.total) }));
    return {
      perKey: perKeyOf(perKey),
      streamed: perKeyOf([...streamed]),
      positions: sorted(
        positions.map((row) => ({ key: row.account, position: Number(row.position) })),
      ),
      early: Number(early.n),
      noMemo: Number(noMemo.n),
    };
  });

  test(
    "every query agrees with the model under the stable name, through rebuilds and promotions",
    Arbitrary.checkEffect(
      ops,
      (sequence) =>
        // The name first: an engine resolves table names when its Layer is built.
        Effect.suspend(() => {
          const name = freshNames ? fresh() : Ledger.spec.name;
          return Effect.gen(function* () {
            const { model } = yield* applySequence(yield* EngineLake.Store, name, sequence);
            const answers = yield* ask;
            const want = modelAnswers(model);
            yield* agree("rows per key", answers.perKey, want.perKey);
            yield* agree("streamed rows", answers.streamed, want.perKey);
            yield* agree("a parameter filter", answers.positions, want.positions);
            yield* agree("a timestamp parameter", answers.early, want.early);
            yield* agree("a metadata column", answers.noMemo, want.noMemo);
            return true;
          }).pipe(
            Effect.provide(layer(Analytics, () => name)),
            Effect.provide(RuntimeContext.phantom),
          );
        }),
      { runs, maxShrinks, seed: "export-engine-conformance" },
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "Passed"
          ? Effect.void
          : Effect.fail(new Error(Arbitrary.formatCheckFailure(result))),
      ),
    ),
    options,
  );

  // ---------------------------------------------------------------- races

  const perKeyNow = Effect.gen(function* () {
    const sql = yield* Analytics.Query;
    const rows = yield* sql.many(PerKey)`
      SELECT ${Ledger.column("key")} AS account, count(*) AS total
      FROM ${Ledger} GROUP BY ${Ledger.column("key")} ORDER BY ${Ledger.column("key")}`;
    return rows.map((row) => ({ key: row.account, rows: Number(row.total) }));
  });
  /** Reads that spanned a step, over every run: a race that never raced proves nothing. */
  let straddled = 0;
  test(
    "queries racing the writer see only states the store passed through",
    Arbitrary.checkEffect(
      raceOps,
      (sequence) =>
        Effect.suspend(() => {
          const name = freshNames ? fresh() : Ledger.spec.name;
          return Effect.gen(function* () {
            const { states, reads } = yield* race({
              store: yield* EngineLake.Store,
              name,
              sequence,
              read: perKeyNow,
            });
            for (const { start, end, value } of reads) {
              const allowed = answersDuring(
                states,
                start,
                end,
                (model) => modelAnswers(model).perKey,
              );
              if (!allowed.has(JSON.stringify(value)))
                yield* agree(
                  `a read during states ${start}..${end} of ${JSON.stringify(sequence)} (the store was only ever ${[...allowed].join(" | ")})`,
                  value,
                  "one of those",
                );
            }
            straddled += reads.filter(({ start, end }) => end > start).length;
            return true;
          }).pipe(
            Effect.provide(layer(Analytics, () => name)),
            Effect.provide(RuntimeContext.phantom),
          );
        }),
      { runs: Math.max(2, Math.ceil(runs / 4)), maxShrinks, seed: "export-engine-race" },
    ).pipe(
      Effect.flatMap((result) =>
        result._tag !== "Passed"
          ? Effect.fail(new Error(Arbitrary.formatCheckFailure(result)))
          : readsInterleave && straddled === 0
            ? Effect.fail(new Error("no read spanned a step: the readers never raced the writer"))
            : Effect.void,
      ),
    ),
    options,
  );

  // ---------------------------------------------------------------- the same query, asked again

  // An engine that keeps a plan from an earlier run answers from what the table held then:
  // DuckDB's grouped text decodes with an empty table's bounds.
  test(
    "a query asked of an empty table, asked again once rows arrive, answers with them",
    Effect.suspend(() => {
      const name = freshNames ? fresh() : Ledger.spec.name;
      return Effect.gen(function* () {
        const store = yield* EngineLake.Store;
        const spec: Export.Spec.TableSpec = { ...Ledger.spec, name };
        const target = store.target(spec);
        yield* target.ensure(spec);
        yield* agree("rows per key before any row", yield* perKeyNow, []);
        yield* target.write(spec, {
          rows: [pool[5]!],
          ingestedAt: DateTime.makeUnsafe(base),
        });
        yield* agree("rows per key once a row arrived", yield* perKeyNow, [{ key: "a3", rows: 1 }]);
      }).pipe(Effect.provide(layer(Analytics, () => name)), Effect.provide(RuntimeContext.phantom));
    }),
    options,
  );

  // ---------------------------------------------------------------- an instant read back

  test(
    "an instant a query returns is the instant written, to the millisecond, with its zone",
    Effect.suspend(() => {
      const name = freshNames ? fresh() : Ledger.spec.name;
      const instants = [
        { key: "a1", seq: 1, at: 0 },
        { key: "a1", seq: 2, at: Date.UTC(2026, 0, 1, 0, 0, 5, 123) },
        { key: "a2", seq: 1, at: Date.UTC(2099, 11, 31, 23, 59, 59, 999) },
      ];
      return Effect.gen(function* () {
        const store = yield* EngineLake.Store;
        const spec: Export.Spec.TableSpec = { ...Ledger.spec, name };
        const target = store.target(spec);
        yield* target.ensure(spec);
        yield* target.write(spec, {
          rows: instants.map((deposit) => depositRow({ ...deposit, amount: 1, memo: null })),
          ingestedAt: DateTime.makeUnsafe(base),
        });
        const sql = yield* Analytics.Query;
        const rows = yield* sql.many(Latest)`
          SELECT ${Ledger.column("key")} AS account, max(${Ledger.column("envelope.at")}) AS latest
          FROM ${Ledger} GROUP BY ${Ledger.column("key")} ORDER BY ${Ledger.column("key")}`;
        yield* agree(
          "the latest instant per key",
          rows.map((row) => ({ key: row.account, latest: instantOf(row.latest) })),
          [
            { key: "a1", latest: new Date(instants[1]!.at).toISOString() },
            { key: "a2", latest: new Date(instants[2]!.at).toISOString() },
          ],
        );
      }).pipe(Effect.provide(layer(Analytics, () => name)), Effect.provide(RuntimeContext.phantom));
    }),
    options,
  );

  // ---------------------------------------------------------------- parameters

  test(
    "every value an engine binds, text, integer or instant, selects what JavaScript's comparison selects",
    Arbitrary.checkEffect(
      deposits,
      (generated) =>
        Effect.suspend(() => {
          const name = freshNames ? fresh() : Ledger.spec.name;
          // In every run: memos a collation could fold together (case, accent, a trailing
          // space), and a quote a literal must escape.
          const fixed = ["a", "a ", "A", "á", "o'c"];
          const written = [
            ...fixed.map((memo, i) => ({ key: "a3", seq: i + 1, at: base, memo })),
            ...generated.filter(
              (row) => !(row.key === "a3" && row.seq >= 1 && row.seq <= fixed.length),
            ),
          ];
          return Effect.gen(function* () {
            const store = yield* EngineLake.Store;
            const spec: Export.Spec.TableSpec = { ...Ledger.spec, name };
            const target = store.target(spec);
            yield* target.ensure(spec);
            yield* target.write(spec, {
              rows: written.map((deposit) => depositRow({ ...deposit, amount: 1 })),
              ingestedAt: DateTime.makeUnsafe(base),
            });
            const sql = yield* Analytics.Query;
            for (const probe of written) {
              if (probe.memo !== null)
                yield* agree(
                  `rows whose memo equals ${JSON.stringify(probe.memo)}`,
                  Number(
                    (yield* sql.one(Count)`SELECT count(*) AS n FROM ${Ledger}
                      WHERE ${Ledger.column("_export_memo")} = ${probe.memo}`).n,
                  ),
                  written.filter((other) => other.memo === probe.memo).length,
                );
              yield* agree(
                `rows before ${new Date(probe.at).toISOString()}`,
                Number(
                  (yield* sql.one(Count)`SELECT count(*) AS n FROM ${Ledger}
                    WHERE ${Ledger.column("envelope.at")} < ${DateTime.makeUnsafe(probe.at)}`).n,
                ),
                written.filter((other) => other.at < probe.at).length,
              );
              yield* agree(
                `rows at position ${probe.seq} or later`,
                Number(
                  (yield* sql.one(Count)`SELECT count(*) AS n FROM ${Ledger}
                    WHERE ${Ledger.column("position")} >= ${probe.seq}`).n,
                ),
                written.filter((other) => other.seq >= probe.seq).length,
              );
            }
            return true;
          }).pipe(
            Effect.provide(layer(Analytics, () => name)),
            Effect.provide(RuntimeContext.phantom),
          );
        }),
      { runs: Math.max(5, Math.ceil(runs / 2)), maxShrinks, seed: "export-engine-parameters" },
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "Passed"
          ? Effect.void
          : Effect.fail(new Error(Arbitrary.formatCheckFailure(result))),
      ),
    ),
    options,
  );
};

/**
 * The script an outside reader reads after: a run, a retry with one new row,
 * a rebuild in generation 1, its promotion, and writes after it.
 */
const outsideScript: ReadonlyArray<typeof Op.Type> = [
  { _tag: "Write", generation: 0, rows: [0, 1, 2, 3, 4, 5, 6, 7], after: 0 },
  { _tag: "Write", generation: 0, rows: [2, 3, 8], after: 1 },
  { _tag: "Write", generation: 1, rows: [0, 1, 2, 9], after: 2 },
  { _tag: "Promote", generation: 1 },
  { _tag: "Write", generation: 1, rows: [3, 4, 5, 8], after: 3 },
];

/**
 * A person at the database's own client: after the script, `client` runs
 * rows-per-key over the table's stable name (the name it is given) and
 * prints one `key<separator>count` line per key, in key order. Every line
 * must be the model's.
 */
export const outsideReader = <R>(options: {
  readonly test: TestFn<R>;
  readonly label: string;
  readonly make: Effect.Effect<ExportStore.Implementation, unknown, R>;
  readonly client: (stableName: string) => Effect.Effect<string, unknown, R>;
  readonly kind: "local" | "live";
}) =>
  options.test(
    `${options.label} reads the stable name as the model has it`,
    Effect.gen(function* () {
      const name = fresh();
      const { model } = yield* applySequence(yield* options.make, name, outsideScript);
      const printed = yield* options.client(name);
      const rows = printed
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [key = "", count = ""] = line
            .split(/[,\t|]/)
            .map((cell) => cell.trim().replace(/^"|"$/g, ""));
          return { key, rows: Number(count) };
        });
      yield* agree(`${options.label}'s rows per key`, rows, modelAnswers(model).perKey);
    }).pipe(Effect.provide(RuntimeContext.phantom)),
    { timeout: 120_000, tags: [options.kind] },
  );

/**
 * Text an engine must bind exactly: quotes and backslashes (Trino renders
 * literals), `%` and `_` (`LIKE`'s wildcards), whitespace including a
 * trailing space (MySQL's PAD SPACE collations ignore it), and characters
 * past ASCII up to a surrogate pair. No NUL: Postgres text cannot hold one.
 */
const alphabet = [
  "a",
  "Z",
  " ",
  "'",
  '"',
  "\\",
  "%",
  "_",
  "\n",
  "\t",
  "é",
  "ß",
  "€",
  "\uFFFD",
  "😀",
  "中",
];
const memo = Arbitrary.schema(
  Schema.NullOr(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: alphabet.length - 1 })),
    ).check(Schema.isMaxLength(8)),
  ),
).pipe(Arbitrary.map((picks) => (picks === null ? null : picks.map((i) => alphabet[i]).join(""))));

/**
 * Deposits with values chosen at the edges engines bind: instants from 1970
 * to 2100, positions over every safe integer (one row per key and position).
 */
const deposits = Arbitrary.array(
  Arbitrary.all({
    key: Arbitrary.schema(Schema.Literals(["a1", "a2", "a3"])),
    at: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_102_444_800_000 })),
    ),
    seq: Arbitrary.schema(
      Schema.Int.check(
        Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
      ),
    ),
    memo,
  }),
  { minLength: 1, maxLength: 6 },
).pipe(
  Arbitrary.filter(
    (rows) => new Set(rows.map((row) => `${row.key}/${row.seq}`)).size === rows.length,
  ),
);
