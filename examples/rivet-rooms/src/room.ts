import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";

const IDLE_MS = 60 * 60 * 1000;

export default class Room extends Rivet.DurableObject<Room>()(
  "Room",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const sql = state.storage.sql;

      yield* (yield* sql.exec(
        "CREATE TABLE IF NOT EXISTS messages (author TEXT NOT NULL, text TEXT NOT NULL)",
      )).toArray();

      return {
        join: () =>
          Effect.gen(function* () {
            const visitors = ((yield* state.storage.get<number>("visitors")) ?? 0) + 1;
            yield* state.storage.put("visitors", visitors);
            return visitors;
          }),
        post: (author: string, text: string) =>
          Effect.gen(function* () {
            yield* (yield* sql.exec(
              "INSERT INTO messages (author, text) VALUES (?, ?)",
              author,
              text,
            )).toArray();
            const now = yield* Effect.sync(() => Date.now());
            yield* state.storage.setAlarm(now + IDLE_MS);
          }),
        messages: () =>
          Effect.gen(function* () {
            const rows = yield* sql.exec<{ author: string; text: string }>(
              "SELECT author, text FROM messages",
            );
            return yield* rows.toArray();
          }),
        alarm: () =>
          Effect.gen(function* () {
            yield* (yield* sql.exec("DELETE FROM messages")).toArray();
          }),
      };
    });
  }).pipe(Effect.provide(Default)),
) {}
