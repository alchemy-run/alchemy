import { Database } from "bun:sqlite";
import type * as cf from "@cloudflare/workers-types";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { ensureAlarmTables } from "@/Cloudflare/Workers/DurableObjectAlarmStorage.ts";
import { DurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import { fromDurableObjectStorage } from "@/Cloudflare/Workers/DurableObjectStorage.ts";
import { processScheduledEvents } from "@/Cloudflare/Workers/ScheduledEvents.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const NOW = 1_700_000_000_001;

interface Seed {
  id: string;
  at: number;
  repeat?: number;
  payload?: string;
}

interface Row {
  id: string;
  run_at: number;
  repeat_ms: number | null;
  payload: string;
}

/** Native SQL semantics come from Bun SQLite; only the DO API boundary is adapted. */
const makeFixture = () => {
  const db = new Database(":memory:");
  const calls: Array<{ sql: string; inTransaction: boolean }> = [];
  const phases: string[] = [];
  let depth = 0;
  let sequence = 0;
  let alarm: number | null = 123;
  let onSnapshot: (() => void) | undefined;
  const begin = () => {
    const name = `transaction_${++sequence}`;
    db.exec(`SAVEPOINT ${name}`);
    depth++;
    return name;
  };
  const finish = (name: string, rollback: boolean) => {
    if (rollback) db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    depth--;
  };
  const raw = {
    sql: {
      exec: (sql: string, ...bindings: unknown[]) => {
        calls.push({ sql, inTransaction: depth > 0 });
        let rows: Array<Record<string, unknown>>;
        if (/^\s*CREATE\s/i.test(sql)) {
          db.exec(sql);
          rows = [];
        } else {
          rows = db.query(sql).all(...(bindings as never[])) as Array<Record<string, unknown>>;
        }
        if (/^\s*SELECT id, run_at, repeat_ms, payload/i.test(sql)) {
          phases.push("snapshot");
          onSnapshot?.();
        } else if (/^\s*(DELETE|UPDATE)\s+(?:FROM\s+)?alchemy_scheduled_events/i.test(sql)) {
          phases.push("mutation");
        } else if (sql.includes("SELECT MIN(run_at)")) {
          phases.push("reconcile");
        }
        let index = 0;
        return {
          [Symbol.iterator]: function* () {
            yield* rows;
          },
          next: () =>
            index < rows.length ? { done: false, value: rows[index++] } : { done: true },
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected one SQL row, got ${rows.length}`);
            return rows[0];
          },
          raw: function* () {
            for (const row of rows) yield Object.values(row);
          },
          columnNames: Object.keys(rows[0] ?? {}),
          rowsRead: rows.length,
          rowsWritten: (db.query("SELECT changes() AS count").get() as { count: number }).count,
        };
      },
    },
    kv: {},
    transactionSync: <A>(body: () => A): A => {
      const name = begin();
      try {
        const result = body();
        finish(name, false);
        return result;
      } catch (cause) {
        finish(name, true);
        throw cause;
      }
    },
    transaction: async <A>(body: (transaction: unknown) => Promise<A>): Promise<A> => {
      const name = begin();
      const previousAlarm = alarm;
      phases.push("begin");
      let rolledBack = false;
      try {
        const result = await body({
          rollback: () => {
            rolledBack = true;
          },
        });
        finish(name, rolledBack);
        if (rolledBack) alarm = previousAlarm;
        phases.push(rolledBack ? "rollback" : "commit");
        return result;
      } catch (cause) {
        finish(name, true);
        alarm = previousAlarm;
        phases.push("rollback");
        throw cause;
      }
    },
    setAlarm: async (at: number | Date) => {
      phases.push("setAlarm");
      alarm = at instanceof Date ? at.getTime() : at;
    },
    deleteAlarm: async () => {
      phases.push("deleteAlarm");
      alarm = null;
    },
  } as unknown as cf.DurableObjectStorage;
  const storage = fromDurableObjectStorage(raw);
  const state = { raw: { storage: raw }, storage } as DurableObjectState["Service"];
  return {
    db,
    raw,
    state,
    calls,
    phases,
    alarm: () => alarm,
    onSnapshot: (hook: () => void) => {
      onSnapshot = hook;
    },
    reset: () => {
      calls.length = 0;
      phases.length = 0;
    },
    seed: (rows: Seed[]) =>
      db.transaction(() => {
        const insert = db.query(
          "INSERT INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload) VALUES (?, ?, ?, ?)",
        );
        for (const row of rows)
          insert.run(
            row.id,
            row.at,
            row.repeat ?? null,
            row.payload ?? JSON.stringify({ id: row.id }),
          );
      })(),
    rows: () =>
      db
        .query("SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id")
        .all() as Row[],
    mutations: () =>
      calls.filter(({ sql }) =>
        /^\s*(DELETE|UPDATE)\s+(?:FROM\s+)?alchemy_scheduled_events/i.test(sql),
      ),
  };
};

const withFixture = <A, E, R>(
  body: (fixture: ReturnType<typeof makeFixture>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeFixture),
    (fixture) =>
      ensureAlarmTables(fixture.raw).pipe(
        Effect.andThen(body(fixture)),
        Effect.provideService(DurableObjectState, fixture.state),
        Effect.provide(RuntimeContext.phantom),
      ),
    (fixture) => Effect.sync(() => fixture.db.close()),
  );

describe("scheduled-event SQL batching", { tags: ["unit", "local"] }, () => {
  it.effect("preserves the ordered snapshot, repeat arithmetic, future rows, and alarm order", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(NOW);
        fixture.seed([
          { id: "future", at: NOW + 10 },
          { id: "fractional", at: NOW - 2, repeat: 0.25 },
          { id: "one-shot", at: NOW - 5 },
          { id: "negative", at: NOW - 3, repeat: -3 },
          { id: "zero", at: NOW, repeat: 0 },
        ]);
        fixture.reset();
        const fired = yield* processScheduledEvents;
        expect(fired.map((event) => event.id)).toEqual([
          "one-shot",
          "negative",
          "fractional",
          "zero",
        ]);
        expect(fired.map((event) => event.runAt.getTime())).toEqual([
          NOW - 5,
          NOW - 3,
          NOW - 2,
          NOW,
        ]);
        expect(fired.map((event) => event.payload)).toEqual(
          fired.map((event) => ({ id: event.id })),
        );
        expect(fixture.rows().map(({ id, run_at }) => [id, run_at])).toEqual([
          ["fractional", NOW + 0.25],
          ["future", NOW + 10],
          ["negative", NOW - 3],
          ["zero", NOW],
        ]);
        expect(fixture.mutations()).toHaveLength(2);
        expect(fixture.calls.every((call) => call.inTransaction)).toBe(true);
        expect(fixture.phases).toEqual([
          "begin",
          "snapshot",
          "mutation",
          "mutation",
          "reconcile",
          "setAlarm",
          "commit",
        ]);
        expect(fixture.alarm()).toBe(NOW + 1);
      }),
    ),
  );

  for (const repeating of [false, true]) {
    it.effect(
      `processes 1,000 ${repeating ? "repeating" : "one-shot"} rows with one SQL mutation`,
      () =>
        withFixture((fixture) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(NOW);
            fixture.seed(
              Array.from({ length: 1_000 }, (_, index) => ({
                id: `event-${index}`,
                at: NOW - 1_000 + index,
                repeat: repeating ? 5_000 : undefined,
              })),
            );
            fixture.reset();
            const fired = yield* processScheduledEvents;
            expect(fired).toHaveLength(1_000);
            expect(new Set(fired.map((event) => event.id)).size).toBe(1_000);
            expect(fired[0].id).toBe("event-0");
            expect(fired[999].id).toBe("event-999");
            expect(fixture.mutations()).toHaveLength(1);
            expect(fixture.rows()).toHaveLength(repeating ? 1_000 : 0);
            expect(fixture.alarm()).toBe(repeating ? NOW + 5_000 : null);
          }),
        ),
    );
  }

  for (const hasFuture of [false, true]) {
    it.effect(`does not issue mutations for ${hasFuture ? "future-only" : "empty"} snapshots`, () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(NOW);
          if (hasFuture) fixture.seed([{ id: "future", at: NOW + 100, repeat: 5 }]);
          const before = fixture.rows();
          fixture.reset();
          expect(yield* processScheduledEvents).toEqual([]);
          expect(fixture.rows()).toEqual(before);
          expect(fixture.mutations()).toHaveLength(0);
          expect(fixture.phases).toEqual([
            "begin",
            "snapshot",
            "reconcile",
            hasFuture ? "setAlarm" : "deleteAlarm",
            "commit",
          ]);
          expect(fixture.alarm()).toBe(hasFuture ? NOW + 100 : null);
        }),
      ),
    );
  }

  it.effect(
    "rolls back every mutation on malformed payload and leaves the native alarm unchanged",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(NOW);
          fixture.seed([
            { id: "valid", at: NOW - 3 },
            { id: "malformed", at: NOW - 2, repeat: 10, payload: "{" },
            { id: "last", at: NOW - 1 },
          ]);
          const before = fixture.rows();
          fixture.reset();
          const result = yield* processScheduledEvents.pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect(fixture.rows()).toEqual(before);
          expect(fixture.alarm()).toBe(123);
          expect(fixture.mutations()).toHaveLength(2);
          expect(fixture.phases).toEqual(["begin", "snapshot", "mutation", "mutation", "rollback"]);
        }),
      ),
  );

  it.effect("matches the previous JavaScript addition even past safe integral precision", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(NOW);
        const repeats = [
          0,
          -1,
          0.25,
          -0.25,
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          2 ** 53 + 2,
          -(2 ** 53 + 2),
          1.5e100,
        ];
        fixture.seed(repeats.map((repeat, index) => ({ id: String(index), at: NOW - 1, repeat })));
        // Store the old JS arithmetic through SQLite's same column affinity,
        // then compare exact stored representations, not rounded read numbers.
        fixture.db.exec("CREATE TABLE expected (id TEXT PRIMARY KEY, run_at INTEGER)");
        const expected = fixture.db.query("INSERT INTO expected VALUES (?, ?)");
        for (const row of fixture.rows()) expected.run(row.id, NOW + row.repeat_ms!);
        fixture.reset();
        yield* processScheduledEvents;
        const actual = fixture.db
          .query("SELECT id, quote(run_at) AS value FROM alchemy_scheduled_events ORDER BY id")
          .all();
        const reference = fixture.db
          .query("SELECT id, quote(run_at) AS value FROM expected ORDER BY id")
          .all();
        expect(actual).toEqual(reference);
        expect(fixture.mutations()).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects a sibling-fiber write between the snapshot and mutations", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(NOW);
        fixture.seed([{ id: "original", at: NOW - 1 }]);
        let sibling: Exit.Exit<unknown, unknown> | undefined;
        fixture.onSnapshot(() => {
          sibling = Effect.runSyncExit(
            fixture.state.storage.sql
              .exec(
                "INSERT INTO alchemy_scheduled_events VALUES (?, ?, ?, ?)",
                "interleaved",
                NOW - 1,
                null,
                "{}",
              )
              .pipe(Effect.provide(RuntimeContext.phantom)),
          );
        });
        fixture.reset();
        const fired = yield* processScheduledEvents;
        expect(fired.map((event) => event.id)).toEqual(["original"]);
        expect(sibling && Exit.isFailure(sibling)).toBe(true);
        if (sibling && Exit.isFailure(sibling)) {
          expect(Cause.squash(sibling.cause)).toMatchObject({ _tag: "DurableObjectStorageError" });
        }
        expect(fixture.rows()).toEqual([]);
        expect(fixture.mutations()).toHaveLength(1);
      }),
    ),
  );
});
