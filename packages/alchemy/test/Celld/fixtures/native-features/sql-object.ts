import { DurableObject } from "@/Celld/DurableObject.ts";
import { DurableObjectState } from "@/Celld/DurableObjectState.ts";
import { SqlMigrations } from "@/Celld/SqlMigrations.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import { WorkerEnvironment } from "@/Workers/Worker.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const constructor = Effect.gen(function* () {
  const dir = (yield* WorkerEnvironment).NATIVE_SQL_DIRECTORY;
  if (typeof dir !== "string")
    return yield* Effect.die("Missing native SQL capture directory");
  const migrations = yield* SqlMigrations({ dir, table: "native_sql_history" });
  const state = yield* DurableObjectState;
  return Effect.gen(function* () {
    const applied = yield* migrations.apply().pipe(Effect.result);
    const applicationError = Result.isFailure(applied)
      ? applied.failure._tag
      : null;
    return {
      inspect: () =>
        Effect.gen(function* () {
          const history = yield* (yield* state.storage.sql.exec<{
            name: string;
            hash: string;
          }>(
            "SELECT name, hash FROM native_sql_history ORDER BY id",
          )).toArray();
          const rows = yield* (yield* state.storage.sql.exec<{ value: string }>(
            "SELECT value FROM items ORDER BY rowid",
          )).toArray();
          const tables = yield* (yield* state.storage.sql.exec<{
            name: string;
          }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'",
          )).toArray();
          return {
            id: yield* Effect.sync(() => state.id.toString()),
            tag: migrations._tag,
            table: migrations.table,
            captured: migrations.records.map(({ name, hash }) => ({
              name,
              hash,
            })),
            applicationError,
            history,
            rows,
            tables,
          };
        }),
      insert: () =>
        state.storage.sql
          .exec("INSERT INTO items VALUES ('user-data')")
          .pipe(Effect.asVoid),
      reapply: () =>
        migrations
          .apply()
          .pipe(Effect.provideService(DurableObjectState, state)),
    };
  });
});

export class NativeSqlObject extends DurableObject<NativeSqlObject>()(
  "NativeSqlObject",
  constructor,
) {}

export const sqlObjectExport = {
  kind: "durableObject",
  provider: "Celld.Worker",
  constructor,
  services: Context.empty(),
} satisfies DurableObjectExport;
