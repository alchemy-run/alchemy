import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SessionEvent } from "../../AI/Session.ts";
import { makeSessionStore, SessionStore } from "../../AI/SessionStore.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

const decodeEvent = Schema.decodeUnknownSync(SessionEvent);

/**
 * An `AI.SessionStore` kept in the owning Durable Object's SQLite storage.
 *
 * A container's disk does not survive sleep, but its Durable Object's
 * storage does — so the session event log lives here, and `events({ after })`
 * replays it across container restarts and DO hibernation. Live tailing is
 * in-isolate (every append for a session happens in its one DO).
 *
 * @example
 * ```typescript
 * export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
 *   "Agent",
 *   { schema: AI.SessionRpcs },
 *   Effect.gen(function* () {
 *     // ...
 *   }).pipe(Effect.provide(Cloudflare.DurableSessionStore)),
 * ) {}
 * ```
 */
export const DurableSessionStore: Layer.Layer<SessionStore, never, DurableObjectState> =
  Layer.effect(SessionStore)(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const sql = state.storage.sql;
      let ready = false;
      const ensure = Effect.suspend(() => {
        if (ready) return Effect.void;
        ready = true;
        return sql
          .exec(
            "CREATE TABLE IF NOT EXISTS alchemy_session_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session_id, cursor))",
          )
          .pipe(Effect.asVoid);
      });
      const run = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
        Effect.andThen(ensure, effect).pipe(Effect.provide(RuntimeContext.phantom));

      return yield* makeSessionStore({
        load: (sessionId, after) =>
          run(
            Effect.flatMap(
              sql.exec<{ event: string }>(
                "SELECT event FROM alchemy_session_events WHERE session_id = ? AND cursor > ? ORDER BY cursor",
                sessionId,
                after,
              ),
              (cursor) => cursor.toArray(),
            ),
          ).pipe(Effect.map((rows) => rows.map((row) => decodeEvent(JSON.parse(row.event))))),
        save: (event) =>
          run(
            sql
              .exec(
                "INSERT INTO alchemy_session_events (session_id, cursor, event) VALUES (?, ?, ?)",
                event.sessionId,
                event.cursor,
                JSON.stringify(event),
              )
              .pipe(Effect.asVoid),
          ),
        latest: (sessionId) =>
          run(
            Effect.flatMap(
              sql.exec<{ latest: number | null }>(
                "SELECT MAX(cursor) AS latest FROM alchemy_session_events WHERE session_id = ?",
                sessionId,
              ),
              (cursor) => cursor.one(),
            ),
          ).pipe(Effect.map((row) => row.latest ?? 0)),
      });
    }),
  );
