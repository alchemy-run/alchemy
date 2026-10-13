import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** The one instance that holds the index. */
export const SESSIONS_INDEX = "index";

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: number;
}

/**
 * Every session, so any browser lists the same ones. Each session's Agent
 * registers itself when it starts.
 */
export class Sessions extends Cloudflare.DurableObject<Sessions>()(
  "Sessions",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;
    let ready = false;
    const ensure = Effect.suspend(() => {
      if (ready) return Effect.void;
      ready = true;
      return sql
        .exec(
          "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
        )
        .pipe(Effect.asVoid);
    });

    return Effect.gen(function* () {
      return {
        register: (id: string) =>
          ensure.pipe(
            Effect.andThen(
              sql.exec(
                "INSERT INTO sessions (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
                id,
                Date.now(),
              ),
            ),
            Effect.asVoid,
          ),
        /** Newest first. */
        list: () =>
          ensure.pipe(
            Effect.andThen(
              sql.exec<{ id: string; created_at: number }>(
                "SELECT id, created_at FROM sessions ORDER BY created_at DESC",
              ),
            ),
            Effect.flatMap((cursor) => cursor.toArray()),
            Effect.map((rows) =>
              rows.map((row): SessionSummary => ({ id: row.id, createdAt: row.created_at })),
            ),
          ),
      };
    });
  }),
) {}
