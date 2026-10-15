import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * What the test workflows did, outside the engine: each activity appends an
 * entry here, so a test can check an activity ran once even though its
 * workflow replayed several times.
 */
export class Journal extends Cloudflare.DurableObject<Journal>()(
  "DurableWorkflowJournal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      yield* state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
      );
      return {
        append: (entry: string) =>
          state.storage.sql
            .exec("INSERT INTO entries (entry) VALUES (?)", entry)
            .pipe(Effect.asVoid),
        list: () =>
          state.storage.sql.exec<{ entry: string }>("SELECT entry FROM entries ORDER BY seq").pipe(
            Effect.flatMap((cursor) => cursor.toArray()),
            Effect.map((rows) => rows.map((row) => row.entry)),
          ),
      };
    });
  }),
) {}
