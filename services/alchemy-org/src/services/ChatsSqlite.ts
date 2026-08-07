/**
 * `AI.Chats` over bun:sqlite — the transcript half of the bootstrap's
 * restart surface (designs/ai/bootstrap.md §3), and the documentary's
 * dialogue track (§4b): every durable driver observation persists, so
 * any past conversation replays in whatever UI exists later.
 *
 * Deliberately a WRAPPER around {@link AI.ChatsMemory}, not a
 * reimplementation: the in-memory projection keeps doing what it does
 * (summaries, streaming accumulation, subscriptions, ring buffer for
 * serving); this layer persists durable observations write-through
 * and REPLAYS them at boot to rebuild the projection. Transients
 * (`assistant-delta`, live `tool-call`) are never persisted — the
 * final `assistant` observation restates the sampling, same rule the
 * memory projection applies to its log.
 *
 * Same sqlite physics as the other org stores: no finalizer, commits
 * per statement, the OS closes the fd at exit.
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

const TABLE = `
CREATE TABLE IF NOT EXISTS observations (
  chat_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  data    TEXT NOT NULL,
  UNIQUE (chat_id, seq) ON CONFLICT REPLACE
)`;

export const ChatsSqlite = (
  path: string,
  options?: AI.ChatsMemoryOptions,
): Layer.Layer<AI.Chats> =>
  Layer.effect(
    AI.Chats,
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => {
          const database = new SqliteDatabase(path, { create: true });
          database.run(TABLE);
          return database;
        },
        catch: (cause) =>
          new Error(`ChatsSqlite failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      // the wrapped in-memory projection — built into a scope that
      // deliberately lives for the process (ChatsMemory registers no
      // finalizers; the scope exists only to satisfy Layer.build)
      const scope = yield* Scope.make();
      const context = yield* AI.ChatsMemory(options).pipe(
        Layer.buildWithScope(scope),
      );
      const memory = Context.get(context, AI.Chats);

      // ── replay: rebuild the projection from the persisted log ────
      // ORDER BY (chat, seq), not rowid: an ON CONFLICT REPLACE gives
      // the replacing row a fresh rowid, which would replay it out of
      // order; seq is the canonical per-chat order.
      const rows = yield* Effect.sync(
        () =>
          db
            .query("SELECT data FROM observations ORDER BY chat_id, seq ASC")
            .all() as Array<{ data: string }>,
      );
      for (const row of rows) {
        yield* memory.ingest(JSON.parse(row.data) as AI.RunObservation);
      }

      // ── write-through ingest ──────────────────────────────────────
      const persist = (observation: AI.RunObservation) =>
        Effect.sync(() => {
          db.query(
            "INSERT INTO observations (chat_id, seq, at, data) VALUES (?, ?, ?, ?)",
          ).run(
            AI.chatId(observation.term, observation.key),
            observation.seq,
            observation.at,
            JSON.stringify(observation),
          );
        });

      return AI.Chats.of({
        ...memory,
        ingest: (observation) =>
          observation.type === "assistant-delta" ||
          observation.type === "tool-call"
            ? memory.ingest(observation)
            : persist(observation).pipe(
                Effect.andThen(memory.ingest(observation)),
              ),
      });
    }),
  );
