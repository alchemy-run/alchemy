import * as Celld from "@alchemy.run/celld";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";

export interface NotesShape {
  insert(value: string): Effect.Effect<void, never, RuntimeContext>;
  list(): Effect.Effect<{ history: string[]; values: string[] }, never, RuntimeContext>;
  count(): Effect.Effect<number, never, RuntimeContext>;
}

/** A SQLite-backed object migrated on activation, with a KV counter. */
export class Notes extends Celld.DurableObject<Notes, NotesShape>()("Notes") {}

export const NotesLive = Notes.make(
  Effect.gen(function* () {
    const migrations = yield* Celld.SqlMigrations({
      // Relative to the directory Alchemy runs in (packages/integration-tests).
      dir: "./test/Celld/fixtures/features/object-migrations",
      table: "notes_history",
    });
    const state = yield* Celld.DurableObjectState;
    return Effect.gen(function* () {
      yield* migrations.apply().pipe(Effect.orDie);
      return {
        insert: (value: string) =>
          Effect.gen(function* () {
            yield* state.storage.sql.exec("INSERT INTO items VALUES (?)", value);
            const count = (yield* state.storage.get<number>("count")) ?? 0;
            yield* state.storage.put("count", count + 1);
          }).pipe(Effect.orDie),
        list: () =>
          Effect.gen(function* () {
            const history = yield* (yield* state.storage.sql.exec<{ name: string }>(
              "SELECT name FROM notes_history ORDER BY id",
            )).toArray();
            const values = yield* (yield* state.storage.sql.exec<{ value: string }>(
              "SELECT value FROM items ORDER BY rowid",
            )).toArray();
            return {
              history: history.map((row) => row.name),
              values: values.map((row) => row.value),
            };
          }).pipe(Effect.orDie),
        count: () =>
          state.storage.get<number>("count").pipe(
            Effect.map((count) => count ?? 0),
            Effect.orDie,
          ),
      } satisfies NotesShape;
    });
  }),
);
