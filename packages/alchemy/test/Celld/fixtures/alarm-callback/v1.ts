import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type { LegacyRow, Snapshot } from "./types.ts";

// Freeze the unversioned persisted layout; do not import the current scheduler.
export class AlarmObject extends DurableObject<unknown> {
  readonly #state: DurableObjectState;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.#state = state;
    state.blockConcurrencyWhile(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS alchemy_scheduled_events (
          id TEXT PRIMARY KEY, run_at INTEGER NOT NULL, repeat_ms INTEGER, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alchemy_scheduled_events_run_at ON alchemy_scheduled_events (run_at);
      `),
          );
          const boots =
            ((yield* Effect.promise(() =>
              state.storage.get<number>("boots"),
            )) ?? 0) + 1;
          yield* Effect.promise(() => state.storage.put("boots", boots));
        }),
      ),
    );
  }

  #reconcile = Effect.gen({ self: this }, function* () {
    const next = yield* Effect.sync(
      () =>
        this.#state.storage.sql
          .exec<{ run_at: number | null }>(
            "SELECT MIN(run_at) AS run_at FROM alchemy_scheduled_events",
          )
          .one().run_at,
    );
    yield* Effect.promise(() =>
      next === null
        ? this.#state.storage.deleteAlarm()
        : this.#state.storage.setAlarm(next),
    );
  });

  #snapshot = Effect.gen({ self: this }, function* () {
    const storage = this.#state.storage;
    const tables = yield* Effect.sync(() =>
      storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='alchemy_alarm_schema'",
        )
        .toArray(),
    );
    const schemaVersion =
      tables.length === 0
        ? null
        : yield* Effect.sync(
            () =>
              storage.sql
                .exec<{ version: number }>(
                  "SELECT version FROM alchemy_alarm_schema WHERE id = 1",
                )
                .one().version,
          );
    return {
      version: "v1",
      id: yield* Effect.sync(() => this.#state.id.toString()),
      boots: (yield* Effect.promise(() => storage.get<number>("boots"))) ?? 0,
      marker:
        (yield* Effect.promise(() => storage.get<string>("marker"))) ?? null,
      delivered:
        (yield* Effect.promise(() => storage.get<string[]>("delivered"))) ?? [],
      legacy: yield* Effect.sync(() =>
        storage.sql
          .exec<LegacyRow>(
            "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
          )
          .toArray(),
      ),
      schemaVersion,
      alarm: yield* Effect.promise(() => storage.getAlarm()),
      attempts: 0,
      recovery: null,
      cleanupWrite: null,
      rows: [],
      pending: [],
      userAlarmAfterCallbacks: false,
      bookkeeping: null,
      transaction: null,
    } satisfies Snapshot;
  });

  fetch(request: Request) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const storage = this.#state.storage;
        const url = yield* Effect.sync(() => new URL(request.url));
        const operation = url.pathname.split("/").filter(Boolean)[1];
        if (operation === "clear") {
          yield* Effect.promise(() => storage.deleteAlarm());
          yield* Effect.sync(() =>
            storage.sql.exec(
              "DROP TABLE IF EXISTS alchemy_alarm_callbacks; DROP TABLE IF EXISTS alchemy_alarm_schema; DELETE FROM alchemy_scheduled_events;",
            ),
          );
          yield* Effect.promise(() => storage.delete(["marker", "delivered"]));
          return yield* Effect.sync(() => Response.json({ cleared: true }));
        }
        if (operation === "seed") {
          const now = yield* Effect.sync(() => Date.now());
          yield* Effect.promise(() => storage.put("marker", "written-by-v1"));
          for (const [id, runAt, repeatMs] of [
            ["v1-proof", now + 500, null],
            ["legacy-one", now + 300_000, null],
            ["legacy-repeat", now + 301_000, 1_000],
            ["legacy-cancel", now + 302_000, null],
          ] as const) {
            yield* Effect.sync(() =>
              storage.sql.exec(
                "INSERT INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload) VALUES (?, ?, ?, ?)",
                id,
                runAt,
                repeatMs,
                JSON.stringify({ value: id }),
              ),
            );
          }
          if (url.searchParams.get("future") === "1") {
            yield* Effect.sync(() =>
              storage.sql.exec(
                "CREATE TABLE alchemy_alarm_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO alchemy_alarm_schema VALUES (1, 99);",
              ),
            );
          }
          yield* this.#reconcile;
        }
        const snapshot = yield* this.#snapshot;
        return yield* Effect.sync(() => Response.json(snapshot));
      }),
    );
  }

  alarm() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const storage = this.#state.storage;
        const now = yield* Effect.sync(() => Date.now());
        const due = yield* Effect.sync(() =>
          storage.sql
            .exec<LegacyRow>(
              "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY id",
              now,
            )
            .toArray(),
        );
        const delivered =
          (yield* Effect.promise(() => storage.get<string[]>("delivered"))) ??
          [];
        for (const row of due) {
          yield* Effect.sync(() =>
            row.repeat_ms === null
              ? storage.sql.exec(
                  "DELETE FROM alchemy_scheduled_events WHERE id = ?",
                  row.id,
                )
              : storage.sql.exec(
                  "UPDATE alchemy_scheduled_events SET run_at = ? WHERE id = ?",
                  now + row.repeat_ms,
                  row.id,
                ),
          );
          delivered.push(`legacy:${row.id}`);
        }
        yield* Effect.promise(() => storage.put("delivered", delivered));
        yield* this.#reconcile;
      }),
    );
  }
}

export default {
  fetch: (request: Request, env: { AlarmObject: DurableObjectNamespace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const name = yield* Effect.sync(
          () => new URL(request.url).pathname.split("/").filter(Boolean)[0],
        );
        if (!name)
          return yield* Effect.sync(
            () => new Response("Not Found", { status: 404 }),
          );
        return yield* Effect.promise(() =>
          env.AlarmObject.getByName(name).fetch(request),
        );
      }),
    ),
};
