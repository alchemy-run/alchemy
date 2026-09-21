import { CallbackError, makeCallback, type Callback } from "@/Callback.ts";
import { DurableObject } from "@/Celld/DurableObject.ts";
import { DurableObjectState } from "@/Celld/DurableObjectState.ts";
import {
  DurableObjectStorageError,
  type DurableObjectTransaction,
  type SqlStorageValue,
} from "@/Celld/DurableObjectStorage.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import { UnsupportedAlarmSchemaVersion } from "@/Workers/Workerd/DurableObjectAlarmStorage.ts";
import type { Bookkeeping, LegacyRow, Snapshot } from "./types.ts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

class Rollback extends Data.TaggedError("Rollback")<{}> {}
class Retry extends Data.TaggedError("Retry")<{}> {}

export class AlarmObject extends DurableObject<AlarmObject>()(
  "AlarmObject",
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const storage = state.storage;
    return Effect.gen(function* () {
      const boots = ((yield* storage.get<number>("boots")) ?? 0) + 1;
      yield* storage.put("boots", boots);
      yield* storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS application (value TEXT NOT NULL)",
      );
      const record = Effect.fn(function* (value: string) {
        const delivered = (yield* storage.get<string[]>("delivered")) ?? [];
        yield* storage.put("delivered", [...delivered, value]);
      });
      const onArchive: Callback<string> = yield* makeCallback(
        "archive",
        (value: string): Effect.Effect<void, CallbackError, RuntimeContext> =>
          Effect.gen(function* () {
            if (value === "first")
              yield* onArchive.schedule("replace", {
                after: "1 second",
                payload: "second",
              });
            yield* record(value);
          }),
      );
      const onRetry = yield* makeCallback(
        "retry",
        (mode: "failure" | "reset") =>
          Effect.gen(function* () {
            const attempts = (yield* storage.get<number>("attempts")) ?? 0;
            yield* storage.put("attempts", attempts + 1);
            yield* storage.put("recovery", yield* storage.getAlarm());
            if (attempts === 0) {
              if (mode === "reset") {
                yield* storage.sync();
                yield* state.abort("callback recovery probe");
              } else return yield* Effect.fail(new Retry());
            }
            yield* record(mode);
          }),
        { retry: { delay: "1 second" } },
      );
      const transactional = yield* storage
        .transaction(makeCallback("transactional-init", record))
        .pipe(Effect.orDie);
      const snapshot = Effect.gen(function* () {
        const tables = (yield* (yield* storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'alchemy_%'",
        )).toArray()).map((row) => row.name);
        return {
          version: "v2",
          id: yield* Effect.sync(() => state.id.toString()),
          boots,
          delivered: (yield* storage.get<string[]>("delivered")) ?? [],
          attempts: (yield* storage.get<number>("attempts")) ?? 0,
          recovery: (yield* storage.get<number>("recovery")) ?? null,
          marker: (yield* storage.get<string>("marker")) ?? null,
          cleanupWrite: (yield* storage.get<string>("cleanupWrite")) ?? null,
          rows: yield* (yield* storage.sql.exec<{ value: string }>(
            "SELECT value FROM application",
          )).toArray(),
          pending: tables.includes("alchemy_alarm_callbacks")
            ? yield* (yield* storage.sql.exec<{ id: string }>(
                "SELECT id FROM alchemy_alarm_callbacks ORDER BY id",
              )).toArray()
            : [],
          legacy: tables.includes("alchemy_scheduled_events")
            ? yield* (yield* storage.sql.exec<LegacyRow>(
                "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
              )).toArray()
            : [],
          schemaVersion: tables.includes("alchemy_alarm_schema")
            ? (yield* (yield* storage.sql.exec<{ version: number }>(
                "SELECT version FROM alchemy_alarm_schema WHERE id = 1",
              )).one()).version
            : null,
          alarm: yield* storage.getAlarm(),
          userAlarmAfterCallbacks:
            (yield* storage.get<boolean>("userAlarmAfterCallbacks")) ?? false,
          bookkeeping: (yield* storage.get<Bookkeeping>("bookkeeping")) ?? null,
          transaction:
            (yield* storage.get<NonNullable<Snapshot["transaction"]>>(
              "transaction",
            )) ?? null,
        } satisfies Snapshot;
      });
      const measureBookkeeping = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const raw = state.raw.storage;
            const counts: Bookkeeping = {
              schemaChecks: 0,
              reconciliations: 0,
              setAlarm: 0,
              deleteAlarm: 0,
            };
            const exec = raw.sql.exec;
            const setAlarm = raw.setAlarm;
            const deleteAlarm = raw.deleteAlarm;
            raw.sql.exec = function <T extends Record<string, SqlStorageValue>>(
              query: string,
              ...bindings: SqlStorageValue[]
            ) {
              if (
                query.includes("SELECT name FROM sqlite_master") &&
                query.includes("alchemy_alarm_schema")
              )
                counts.schemaChecks++;
              if (query.includes("SELECT MIN(run_at) AS run_at FROM ("))
                counts.reconciliations++;
              return exec.call(raw.sql, query, ...bindings) as ReturnType<
                typeof raw.sql.exec<T>
              >;
            };
            raw.setAlarm = (time, options) => {
              counts.setAlarm++;
              return setAlarm.call(raw, time, options);
            };
            raw.deleteAlarm = (options) => {
              counts.deleteAlarm++;
              return deleteAlarm.call(raw, options);
            };
            return { raw, counts, exec, setAlarm, deleteAlarm };
          }),
          ({ counts }) => effect.pipe(Effect.as(counts)),
          ({ raw, exec, setAlarm, deleteAlarm }) =>
            Effect.sync(() => {
              raw.sql.exec = exec;
              raw.setAlarm = setAlarm;
              raw.deleteAlarm = deleteAlarm;
            }),
        );
      return {
        snapshot: () => snapshot,
        seed: Effect.fn(function* (mode: string) {
          if (mode === "retry" || mode === "reset") {
            yield* onRetry.schedule("retry", {
              after: "1 second",
              payload: mode === "retry" ? "failure" : "reset",
            });
          } else if (mode === "replace") {
            yield* onArchive.schedule("replace", {
              after: "1 second",
              payload: "first",
            });
          } else if (mode === "batch") {
            const at = yield* Effect.sync(() => Date.now() + 1_000);
            const counts = yield* measureBookkeeping(
              storage.transaction(
                Effect.gen(function* () {
                  for (let i = 0; i < 103; i++)
                    yield* onArchive.schedule(String(i), {
                      at,
                      payload: String(i),
                    });
                  yield* storage.transaction(
                    Effect.gen(function* () {
                      yield* onArchive.schedule("nested", {
                        at,
                        payload: "nested",
                      });
                      yield* onArchive.cancel("absent");
                    }),
                  );
                  yield* Effect.addFinalizer(() =>
                    onArchive
                      .schedule("finalizer", { at, payload: "finalizer" })
                      .pipe(Effect.orDie),
                  );
                }),
              ),
            );
            yield* storage.put("bookkeeping", counts);
          } else if (mode.startsWith("rollback")) {
            yield* onArchive.schedule("keep", {
              after: "5 minutes",
              payload: "kept",
            });
            const alarmBefore = yield* storage.getAlarm();
            let cleanupFinished = false;
            const writes = Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* storage.put("cleanupWrite", "rolled-back");
                  cleanupFinished = true;
                }),
              );
              yield* storage.put("marker", "rolled-back");
              yield* storage.sql.exec(
                "INSERT INTO application VALUES ('rolled-back')",
              );
              yield* onArchive.cancel("keep");
              yield* onArchive.schedule("rolled-back", {
                after: "1 second",
                payload: "rolled-back",
              });
              yield* storage.getAlarm();
            });
            const exit =
              mode === "rollback-interrupt"
                ? yield* Effect.scoped(
                    Effect.gen(function* () {
                      const entered = yield* Deferred.make<void>();
                      const fiber = yield* storage
                        .transaction(
                          writes.pipe(
                            Effect.andThen(
                              Deferred.succeed(entered, undefined),
                            ),
                            Effect.andThen(Effect.never),
                          ),
                        )
                        .pipe(Effect.forkScoped);
                      yield* Deferred.await(entered).pipe(
                        Effect.timeout("3 seconds"),
                        Effect.orDie,
                      );
                      yield* Fiber.interrupt(fiber);
                      return yield* Fiber.await(fiber);
                    }),
                  )
                : yield* storage
                    .transaction(
                      writes.pipe(
                        Effect.andThen(
                          mode === "rollback-defect"
                            ? Effect.die("rollback-defect")
                            : Effect.fail(new Rollback()),
                        ),
                      ),
                    )
                    .pipe(Effect.exit);
            const cause = Exit.isFailure(exit)
              ? Cause.squash(exit.cause)
              : undefined;
            const failure =
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                ? "interrupted"
                : cause instanceof Rollback
                  ? "Rollback"
                  : String(cause);
            yield* storage.put("transaction", {
              failure,
              alarmBefore,
              alarmAfter: yield* storage.getAlarm(),
              cleanupFinished,
            });
          } else if (mode === "upgrade") {
            yield* storage.transaction(
              Effect.gen(function* () {
                yield* onArchive.schedule("upgraded", {
                  after: "1 second",
                  payload: "upgraded",
                });
                yield* storage.sql.exec(
                  "DELETE FROM alchemy_scheduled_events WHERE id = 'legacy-cancel'",
                );
                const at = yield* Effect.sync(() => Date.now() + 1_000);
                yield* storage.sql.exec(
                  "UPDATE alchemy_scheduled_events SET run_at = ?",
                  at,
                );
                yield* onArchive.cancel("absent");
              }),
            );
          } else {
            yield* storage.transaction(
              Effect.gen(function* () {
                yield* storage.put("marker", "committed");
                yield* storage.sql.exec(
                  "INSERT INTO application VALUES ('committed')",
                );
                yield* onArchive.schedule("same", {
                  after: "1 second",
                  payload: "superseded",
                });
                yield* onArchive.schedule("same", {
                  after: "1 second",
                  payload: "committed",
                });
                yield* onArchive.schedule("cancelled", {
                  after: "1 second",
                  payload: "cancelled",
                });
                yield* onArchive.cancel("cancelled");
                yield* transactional.schedule("init", {
                  after: "1 second",
                  payload: "transactional-init",
                });
              }),
            );
          }
        }),
        late: () =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(
              makeCallback("late", () => Effect.void),
            );
            const cause = Exit.isFailure(result)
              ? Cause.squash(result.cause)
              : undefined;
            return cause instanceof CallbackError ? cause._tag : null;
          }),
        probe: Effect.fn(function* (kind: string) {
          const before = yield* snapshot;
          const exit =
            kind === "owner"
              ? yield* storage.transaction(
                  Effect.gen(function* () {
                    const sibling = yield* storage
                      .put("foreignWrite", "forbidden")
                      .pipe(Effect.exit, Effect.forkScoped);
                    return yield* Fiber.join(sibling);
                  }),
                )
              : kind === "explicit"
                ? yield* storage.transaction(
                    Effect.fn(function* (txn: DurableObjectTransaction) {
                      yield* txn.put("marker", "rolled-back");
                      yield* txn.rollback();
                      yield* txn.rollback();
                      return yield* Effect.exit(
                        storage.put("foreignWrite", "forbidden"),
                      );
                    }),
                  )
                : yield* storage
                    .transaction(
                      Effect.gen(function* () {
                        yield* onArchive.schedule("schema-probe", {
                          after: "5 minutes",
                          payload: "schema-probe",
                        });
                        if (kind === "rollback")
                          return yield* Effect.fail(new Rollback());
                      }),
                    )
                    .pipe(Effect.exit);
          const cause = Exit.isFailure(exit)
            ? Cause.squash(exit.cause)
            : undefined;
          const failure =
            cause instanceof UnsupportedAlarmSchemaVersion
              ? cause._tag
              : cause instanceof DurableObjectStorageError
                ? cause._tag
                : cause instanceof Rollback
                  ? cause._tag
                  : null;
          return {
            failure,
            before,
            after: yield* snapshot,
            foreignWrite: (yield* storage.get<string>("foreignWrite")) ?? null,
          };
        }),
        cancelLegacyRepeat: () =>
          storage.transaction(
            Effect.gen(function* () {
              yield* storage.sql.exec(
                "DELETE FROM alchemy_scheduled_events WHERE id = 'legacy-repeat'",
              );
              yield* onArchive.cancel("absent");
            }),
          ),
        alarm: () =>
          storage
            .transaction(
              Effect.gen(function* () {
                const now = yield* Effect.sync(() => Date.now());
                const due = yield* (yield* storage.sql.exec<LegacyRow>(
                  "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY id",
                  now,
                )).toArray();
                for (const row of due) {
                  yield* row.repeat_ms === null
                    ? storage.sql.exec(
                        "DELETE FROM alchemy_scheduled_events WHERE id = ?",
                        row.id,
                      )
                    : storage.sql.exec(
                        "UPDATE alchemy_scheduled_events SET run_at = ? WHERE id = ?",
                        now + row.repeat_ms,
                        row.id,
                      );
                  yield* record(`legacy:${row.id}`);
                }
                if (due.length > 0) yield* onArchive.cancel("absent");
                const delivered =
                  (yield* storage.get<string[]>("delivered")) ?? [];
                yield* storage.put(
                  "userAlarmAfterCallbacks",
                  delivered.length > 0,
                );
              }),
            )
            .pipe(Effect.orDie),
        clear: () =>
          Effect.gen(function* () {
            yield* storage.deleteAlarm();
            yield* storage.deleteAll();
            yield* storage.sql.exec(
              "DROP TABLE IF EXISTS alchemy_alarm_callbacks; DROP TABLE IF EXISTS alchemy_alarm_schema; DROP TABLE IF EXISTS alchemy_scheduled_events; DROP TABLE IF EXISTS application;",
            );
            yield* storage.put("boots", boots);
            yield* storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS application (value TEXT NOT NULL)",
            );
          }),
      };
    });
  }),
) {}
