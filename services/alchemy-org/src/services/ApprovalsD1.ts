import * as D1 from "alchemy/Cloudflare/D1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Approvals, type ApprovalOutcome } from "./Approvals.ts";
import { inWorker, database } from "./Database.ts";

const TABLE = `
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  session_term TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  action       TEXT NOT NULL,
  at           INTEGER NOT NULL,
  outcome      TEXT
)`;

/** Poll cadence and window: 2s × 150 = the same 5-minute gate as local. */
const POLL_EVERY = "2 seconds";
const POLL_TIMES = 150;

/**
 * The approval gate's CLOUDFLARE physics: pending requests are D1 rows, so the gate
 * works across a stateless Worker fleet — a tool asking inside one
 * session's Durable Object and the operator answering through any
 * Worker instance agree in the database.
 *
 * `ask` POLLS its row (there is no cross-isolate Deferred): a bounded
 * `Effect.repeat` until the operator answers or the window closes —
 * fail CLOSED, same contract as local. Answered/expired rows are
 * deleted by the asker (the one reader), so `pending` stays the live
 * list.
 */
export const ApprovalsD1 = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const db = yield* D1.QueryDatabase(database);
    const mode = yield* Config.string("ORG_APPROVALS").pipe(
      Config.withDefault(""),
    );
    const armed = mode === "ask";

    const ensured = yield* Effect.cached(
      inWorker(db.exec(TABLE.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid)),
    );

    return {
      ask: (request) =>
        !armed
          ? Effect.succeed("allowed-once" as const)
          : Effect.gen(function* () {
              yield* ensured;
              const id = `approval-${crypto.randomUUID()}`;
              yield* inWorker(
                db
                  .prepare(
                    "INSERT INTO approvals (id, session_term, session_key, action, at) VALUES (?, ?, ?, ?, ?)",
                  )
                  .bind(
                    id,
                    request.session.term,
                    request.session.key,
                    request.action,
                    Date.now(),
                  )
                  .run(),
              );
              const answered = yield* inWorker(
                db
                  .prepare("SELECT outcome FROM approvals WHERE id = ?")
                  .bind(id)
                  .first<{ outcome: string | null }>(),
              ).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced(POLL_EVERY),
                  until: (row) => row === null || row.outcome !== null,
                  times: POLL_TIMES,
                }),
              );
              // the asker is the one reader — reap the row either way
              yield* inWorker(
                db.prepare("DELETE FROM approvals WHERE id = ?").bind(id).run(),
              );
              const outcome = answered?.outcome;
              return outcome === "allowed-once" || outcome === "rejected"
                ? (outcome as ApprovalOutcome)
                : ("unavailable" as const); // window closed: fail CLOSED
            }),
      pending: () =>
        Effect.gen(function* () {
          yield* ensured;
          const rows = yield* inWorker(
            db
              .prepare(
                "SELECT * FROM approvals WHERE outcome IS NULL ORDER BY at ASC",
              )
              .all<{
                id: string;
                session_term: string;
                session_key: string;
                action: string;
                at: number;
              }>(),
          );
          return rows.results.map((row) => ({
            id: row.id,
            session: { term: row.session_term, key: row.session_key },
            action: row.action,
            at: row.at,
          }));
        }),
      answer: (id, outcome) =>
        Effect.gen(function* () {
          yield* ensured;
          const result = yield* inWorker(
            db
              .prepare(
                "UPDATE approvals SET outcome = ? WHERE id = ? AND outcome IS NULL",
              )
              .bind(outcome, id)
              .run(),
          );
          return result.meta.changes > 0;
        }),
    };
  }),
);
