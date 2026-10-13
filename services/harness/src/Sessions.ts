import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** The one instance that holds the index. */
export const SESSIONS_INDEX = "index";

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: number;
  /** When it was settled: its machine stopped, and it's archived out of the way. */
  readonly settledAt?: number;
}

/**
 * Every session, so any browser lists the same ones. Each session's Agent
 * registers itself when it starts, marks itself settled when it's settled,
 * and unsettled when it gets a new prompt.
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
      return Effect.gen(function* () {
        yield* sql.exec(
          "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
        );
        const columns = yield* sql
          .exec<{ name: string }>("PRAGMA table_info(sessions)")
          .pipe(Effect.flatMap((cursor) => cursor.toArray()));
        if (!columns.some((column) => column.name === "settled_at")) {
          yield* sql.exec("ALTER TABLE sessions ADD COLUMN settled_at INTEGER");
        }
      });
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
        settle: (id: string) =>
          ensure.pipe(
            Effect.andThen(
              sql.exec("UPDATE sessions SET settled_at = ? WHERE id = ?", Date.now(), id),
            ),
            Effect.asVoid,
          ),
        unsettle: (id: string) =>
          ensure.pipe(
            Effect.andThen(sql.exec("UPDATE sessions SET settled_at = NULL WHERE id = ?", id)),
            Effect.asVoid,
          ),
        /** Newest first. */
        list: () =>
          ensure.pipe(
            Effect.andThen(
              sql.exec<{ id: string; created_at: number; settled_at: number | null }>(
                "SELECT id, created_at, settled_at FROM sessions ORDER BY created_at DESC",
              ),
            ),
            Effect.flatMap((cursor) => cursor.toArray()),
            Effect.map((rows) =>
              rows.map((row): SessionSummary => ({
                id: row.id,
                createdAt: row.created_at,
                ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
              })),
            ),
          ),
      };
    });
  }),
) {}
