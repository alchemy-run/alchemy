import { makeQueryDatabaseClient } from "@/Celld/D1/QueryDatabase.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "@/Celld/D1/Native.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

const fixture = () => {
  const calls: Array<{ sql: string; binds: unknown[]; method: string }> = [];
  const source = "  SELECT ? AS n; -- preserve original SQL\n";
  const meta = {
    duration: 0.25,
    changes: 0,
    last_row_id: 0,
    rows_read: 1,
    rows_written: 0,
    size_after: 8192,
    changed_db: false,
    served_by: "celld",
    served_by_region: "local",
    served_by_primary: true,
    preparedSql: source,
  };
  const makeResult = <T>(): D1Result<T> => ({
    success: true,
    results: [],
    meta,
  });
  const result = makeResult<never>();
  const statement = (
    sql: string,
    binds: unknown[] = [],
  ): D1PreparedStatement => {
    const record = (method: string) => calls.push({ sql, binds, method });
    function raw<T = unknown[]>(): Promise<T[]>;
    function raw<T = unknown[]>(options: {
      columnNames: true;
    }): Promise<[string[], ...T[]]>;
    function raw(options?: { columnNames: true }): Promise<unknown[]> {
      return Effect.runPromise(
        Effect.sync(() => {
          record("raw");
          return options ? [["n"]] : [];
        }),
      );
    }
    return {
      bind: (...values) => statement(sql, values),
      all: <T>(): Promise<D1Result<T>> =>
        Effect.runPromise(
          Effect.sync(() => {
            record("all");
            return makeResult<T>();
          }),
        ),
      run: <T>(): Promise<D1Result<T>> =>
        Effect.runPromise(
          Effect.sync(() => {
            record("run");
            return makeResult<T>();
          }),
        ),
      first: (column?: string) =>
        Effect.runPromise(
          Effect.sync(() => {
            record(`first:${column ?? ""}`);
            if (column === "missing") throw new Error("D1_COLUMN_NOTFOUND");
            return null;
          }),
        ),
      raw,
    };
  };
  const native: D1Database = {
    prepare: (sql) => statement(sql),
    exec: (sql) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ sql, binds: [], method: "exec" });
          return { count: 2, duration: 1.5 };
        }),
      ),
    batch: <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({
            sql: "",
            binds: [],
            method: `batch:${statements.length}`,
          });
          return statements.map(() => makeResult<T>());
        }),
      ),
    withSession: () => {
      throw new Error("not used");
    },
    dump: () => Effect.runPromise(Effect.die("not supported")),
  };
  return {
    calls,
    source,
    meta,
    result,
    native,
    client: makeQueryDatabaseClient(Effect.succeed(native)),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RuntimeContext.phantom)));

test(
  "native query builders preserve exact SQL, empty results, null first, and metadata",
  () =>
    run(
      Effect.gen(function* () {
        const { calls, source, result, native, client } = fixture();
        const statement = client.prepare(source).bind("old").bind(null);
        expect(calls).toEqual([]);
        expect(yield* client.raw).toBe(native);
        expect(yield* statement.all()).toEqual(result);
        expect(yield* statement.run()).toEqual(result);
        expect(yield* statement.first()).toBeNull();
        expect(yield* statement.first("n")).toBeNull();
        expect(yield* statement.raw()).toEqual([]);
        expect(yield* statement.raw({ columnNames: true })).toEqual([["n"]]);
        expect(calls.every((call) => call.sql === source)).toBe(true);
        expect(
          calls.every(
            (call) => call.binds.length === 1 && call.binds[0] === null,
          ),
        ).toBe(true);
        expect(result.meta.preparedSql).toBe(source);
      }),
    ),
  { timeout: 30_000 },
);

test(
  "native batch delegates one transactional call without using operator statements",
  () =>
    run(
      Effect.gen(function* () {
        const { calls, client, result } = fixture();
        const statements = [
          client.prepare("SELECT 1"),
          client.prepare("SELECT ?").bind(2),
        ];
        expect(yield* client.batch(statements)).toEqual([result, result]);
        expect(calls).toEqual([{ sql: "", binds: [], method: "batch:2" }]);
        expect(yield* client.exec("SELECT 1; SELECT 2;")).toEqual({
          count: 2,
          duration: 1.5,
        });
        expect(calls.at(-1)?.sql).toBe("SELECT 1; SELECT 2;");
      }),
    ),
  { timeout: 30_000 },
);
