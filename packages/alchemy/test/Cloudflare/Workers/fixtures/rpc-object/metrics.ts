import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

export type Metric = {
  sequence: number;
  event: string;
};

export class RpcObjectMetrics extends Cloudflare.DurableObject<RpcObjectMetrics>()(
  "RpcObjectMetrics",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        ready: () => Effect.succeed("metrics-ready"),
        append: (event: string) =>
          Effect.sync(() => {
            const sql = state.raw.storage.sql;
            sql.exec(
              "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
            );
            sql.exec("INSERT INTO events (event) VALUES (?)", event);
          }),
        read: () =>
          Effect.sync((): Metric[] => {
            const sql = state.raw.storage.sql;
            const exists = sql
              .exec(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
              )
              .toArray();
            return exists.length === 0
              ? []
              : sql
                  .exec<Metric>(
                    "SELECT sequence, event FROM events ORDER BY sequence",
                  )
                  .toArray();
          }),
      };
    }),
  ),
) {}
