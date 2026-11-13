import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import * as Export from "@alchemy.run/domain/Export";
import * as ExportDuckDb from "@alchemy.run/domain/Export/DuckDb";
import type { Sql } from "@alchemy.run/domain/Export/Engine";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { afterAll, beforeAll, describe, expect, it } from "@alchemy.run/test";
import { LibsqlClient } from "@effect/sql-libsql";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Int }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Deposited],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Deposit],
  decide: { Deposit: (_, { amount }) => [new Deposited({ amount })] },
  evolve: { Deposited: (s) => s },
}) {}
class Ledger extends Export.Table(
  "Ledger",
  { from: [Account], key: Account, on: [Deposited] },
  { table: "ledger" },
) {}
class Bank extends Domain.Model("Bank", { aggregates: [Account], projections: [Ledger] }) {}

/** Rows per key, as an engine counts them. */
const PerKey = Schema.Struct({ key: Schema.String, rows: Schema.Int });

// ---------------------------------------------------------------- DuckDB over the memory store

class Lake extends Export.Store("Lake", { tables: [Ledger] }) {}
class Analytics extends Export.Engine("Analytics", { stores: [Lake], dialect: "duckdb" }) {}

// ---------------------------------------------------------------- a SQL engine over the SQL store

class Warehouse extends Export.Store("Warehouse", { tables: [Ledger] }) {}
class Reporting extends Export.Engine("Reporting", { stores: [Warehouse], dialect: "sqlite" }) {}

/** The warehouse's SQLite file, in a directory the suite makes when it starts and removes when it ends. */
let directory = "";
const database = Layer.unwrap(
  Effect.sync(() => LibsqlClient.layer({ url: `file:${join(directory, "warehouse.db")}` })),
);
const warehouse = Layer.mergeAll(
  Warehouse.toLayer(Export.Sql.store()),
  Reporting.toLayer(Export.Sql.engine({ stream: "collect" })),
).pipe(Layer.provideMerge(database));

/** A row of `key` as the table writes it. */
const rowOf = (key: string, seq: number) =>
  Effect.orDie(
    Schema.encodeEffect(Schema.toCodecJson(Ledger.Row))({
      key: { id: key },
      position: seq,
      envelope: {
        id: `${key}-${seq}`,
        stream: `Account/${key}`,
        seq,
        at: DateTime.makeUnsafe(Date.parse("2026-01-01T00:00:00.000Z")),
        commandId: "c",
        correlationId: "c",
      },
      event: new Deposited({ amount: seq }),
    }),
  );

const perKey = Effect.gen(function* () {
  const sql = yield* Reporting.Query;
  return yield* sql.many(
    PerKey,
  )`SELECT ${Ledger.column("key")} AS key, count(*) AS rows FROM ${Ledger} GROUP BY 1 ORDER BY 1`;
});

describe("Domain Export engines", { tags: ["unit", "local"] }, () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "export-engine-"));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  it.effect("DuckDB queries what a hosted table exported, by its declarations", () =>
    Effect.gen(function* () {
      const a1 = Account.ref("a1");
      const b2 = Account.ref("b2");
      yield* Story.make(Bank, { layer: Ledger.layer().pipe(Layer.provide(Lake.place(Ledger))) })(
        Story.when(a1, new Deposit({ amount: 5 })),
        Story.then(a1, new Deposited({ amount: 5 })),
        Story.when(a1, new Deposit({ amount: 7 })),
        Story.then(a1, new Deposited({ amount: 7 })),
        Story.when(b2, new Deposit({ amount: 1 })),
        Story.then(b2, new Deposited({ amount: 1 })),
      );
      const sql = yield* Analytics.Query;
      const rows = yield* sql.many(
        PerKey,
      )`SELECT ${Ledger.column("key")} AS key, CAST(count(*) AS INTEGER) AS rows FROM ${Ledger} GROUP BY 1 ORDER BY 1`;
      expect(rows).toEqual([
        { key: "a1", rows: 2 },
        { key: "b2", rows: 1 },
      ]);
      const big = yield* sql.one(
        Schema.Struct({ total: Schema.Int }),
      )`SELECT CAST(sum(CAST(json_extract(${Ledger.column("event")}, '$.amount') AS INTEGER)) AS INTEGER) AS total FROM ${Ledger} WHERE ${Ledger.column("key")} = ${"a1"}`;
      expect(big.total).toBe(12);
    }).pipe(
      // The lake outlives the story, so the engine reads what the story's projection wrote.
      Effect.provide(ExportDuckDb.memory(Analytics).pipe(Layer.provideMerge(Lake.memory()))),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  it.effect(
    "a SQL engine reads a table under its stable name: the first generation, then the promoted one",
    () =>
      Effect.gen(function* () {
        const store = yield* Warehouse.Store;
        const v0 = Ledger.spec;
        const v1: Export.Spec.TableSpec = { ...Ledger.spec, generation: 1 };
        const target = store.target(v0);
        yield* target.ensure(v0);
        yield* target.write(v0, {
          rows: [yield* rowOf("a1", 1), yield* rowOf("a1", 2)],
          ingestedAt: DateTime.makeUnsafe(0),
        });
        expect(yield* perKey).toEqual([{ key: "a1", rows: 2 }]);
        // A rebuild into v1 is invisible until it is promoted.
        yield* target.ensure(v1);
        yield* target.write(v1, {
          rows: [yield* rowOf("a1", 1), yield* rowOf("b2", 1)],
          ingestedAt: DateTime.makeUnsafe(0),
        });
        expect(yield* perKey).toEqual([{ key: "a1", rows: 2 }]);
        yield* target.promote(v1);
        expect(yield* perKey).toEqual([
          { key: "a1", rows: 1 },
          { key: "b2", rows: 1 },
        ]);
      }).pipe(Effect.provide(warehouse), Effect.provide(RuntimeContext.phantom)),
  );

  it("queries name only tables and columns their engine's stores hold", () => {
    class Elsewhere extends Export.Table(
      "Elsewhere",
      { from: [Account], key: Account, on: [Deposited] },
      { table: "elsewhere" },
    ) {}
    const typeOnly = (sql: Sql<typeof Reporting.stores>) => {
      // @ts-expect-error a table no store of the engine holds
      void sql.many(PerKey)`SELECT * FROM ${Elsewhere}`;
      // @ts-expect-error a column the table does not have
      void Ledger.column("envelope.nope");
      void sql.many(PerKey)`SELECT * FROM ${Ledger} WHERE ${Ledger.column("envelope.seq")} > ${1}`;
    };
    expect(typeof typeOnly).toBe("function");
  });

  // `DuckDb.layer` turns compressed materialization off; a caller may turn it back on, and a plan
  // kept from an emptier table then decodes grouped text with that table's bounds.
  it.effect(
    "with every optimizer on, a query asked again answers from the table as it is now",
    () =>
      Effect.gen(function* () {
        const duckdb = yield* ExportDuckDb.DuckDb;
        yield* duckdb.exec(`CREATE TABLE t (ord BIGINT, "key" VARCHAR)`);
        const perKey = Statement.fragment([
          Statement.literal(`SELECT "key", count(*) AS n FROM t GROUP BY 1`),
        ]);
        expect(yield* duckdb.query(perKey)).toEqual([]);
        yield* duckdb.exec(`INSERT INTO t VALUES (1, 'a3')`);
        expect((yield* duckdb.query(perKey)).map((row) => row.key)).toEqual(["a3"]);
      }).pipe(
        Effect.provide(Layer.orDie(ExportDuckDb.layer({ config: { disabled_optimizers: "" } }))),
      ),
  );
});
