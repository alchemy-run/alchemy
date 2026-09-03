import * as D1 from "alchemy/Cloudflare/D1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker, database } from "../platform/Database.ts";
import {
  type Proposal,
  type ProposalPayload,
  type ProposalStatus,
  Proposals,
  proposalNumber,
} from "./Proposals.ts";

const TABLE = `
CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  session_term TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload      TEXT NOT NULL,
  at           INTEGER NOT NULL,
  revised_at   INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',
  resolved_at  INTEGER,
  result       TEXT,
  error        TEXT,
  reason       TEXT
)`;

interface Row {
  id: string;
  session_term: string;
  session_key: string;
  repo: string;
  number: number | null;
  kind: string;
  summary: string;
  payload: string;
  at: number;
  revised_at: number | null;
  status: ProposalStatus;
  resolved_at: number | null;
  result: string | null;
  error: string | null;
  reason: string | null;
}

const fromRow = (row: Row): Proposal => ({
  id: row.id,
  session: { term: row.session_term, key: row.session_key },
  repo: row.repo,
  number: row.number ?? undefined,
  summary: row.summary,
  payload: JSON.parse(row.payload) as ProposalPayload,
  at: row.at,
  revisedAt: row.revised_at ?? undefined,
  status: row.status,
  resolvedAt: row.resolved_at ?? undefined,
  result: row.result ?? undefined,
  error: row.error ?? undefined,
  reason: row.reason ?? undefined,
});

/** The listing's horizon — resolved proposals older than this drop
 *  out of the UI (they stay in the table as the record). */
const LIST_LIMIT = 200;

/**
 * Proposals on D1 — one table every session DO (which files them) and
 * every Worker instance (which lists and resolves them for the
 * operator) shares. A single writer: fine for one repository's traffic,
 * and the reason the Worker runs `ProposalsDO` instead (one Durable
 * Object per pull request). Kept as the variant for a deploy that
 * already has its rows here.
 */
export const ProposalsD1 = Layer.effect(
  Proposals,
  Effect.gen(function* () {
    const db = yield* D1.QueryDatabase(database);
    const ensured = yield* Effect.cached(
      inWorker(
        db.exec(TABLE.trim().replaceAll(/\s+/g, " ")).pipe(
          // tables created before revisions existed: add the column;
          // "duplicate column name" on every later boot is the no-op
          Effect.andThen(
            db
              .exec("ALTER TABLE proposals ADD COLUMN revised_at INTEGER")
              .pipe(Effect.ignore),
          ),
          Effect.asVoid,
        ),
      ),
    );

    return Proposals.of({
      propose: (input) =>
        Effect.gen(function* () {
          yield* ensured;
          const proposal: Proposal = {
            id: `proposal-${crypto.randomUUID()}`,
            session: input.session,
            repo: input.repo,
            number: proposalNumber(input.payload),
            summary: input.summary,
            payload: input.payload,
            at: Date.now(),
            revisedAt: undefined,
            status: "pending",
            resolvedAt: undefined,
            result: undefined,
            error: undefined,
            reason: undefined,
          };
          yield* inWorker(
            db
              .prepare(
                `INSERT INTO proposals (id, session_term, session_key, repo, number, kind, summary, payload, at, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
              )
              .bind(
                proposal.id,
                proposal.session.term,
                proposal.session.key,
                proposal.repo,
                proposal.number ?? null,
                proposal.payload.kind,
                proposal.summary,
                JSON.stringify(proposal.payload),
                proposal.at,
              )
              .run(),
          );
          return proposal;
        }),
      revise: (id, input) =>
        Effect.gen(function* () {
          yield* ensured;
          const result = yield* inWorker(
            db
              .prepare(
                `UPDATE proposals SET summary = ?, payload = ?, number = ?, revised_at = ?
                 WHERE id = ? AND status = 'pending'`,
              )
              .bind(
                input.summary,
                JSON.stringify(input.payload),
                proposalNumber(input.payload) ?? null,
                Date.now(),
                id,
              )
              .run(),
          );
          return result.meta.changes > 0;
        }),
      list: (filter) =>
        Effect.gen(function* () {
          yield* ensured;
          const where: Array<string> = [];
          const binds: Array<string | number> = [];
          if (filter?.repo !== undefined) {
            where.push("repo = ?");
            binds.push(filter.repo);
          }
          if (filter?.number !== undefined) {
            where.push("number = ?");
            binds.push(filter.number);
          }
          if (filter?.status !== undefined) {
            where.push("status = ?");
            binds.push(filter.status);
          }
          if (filter?.session !== undefined) {
            where.push("session_term = ? AND session_key = ?");
            binds.push(filter.session.term, filter.session.key);
          }
          const rows = yield* inWorker(
            db
              .prepare(
                `SELECT * FROM proposals${
                  where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
                } ORDER BY at DESC LIMIT ${LIST_LIMIT}`,
              )
              .bind(...binds)
              .all<Row>(),
          );
          return rows.results.map(fromRow);
        }),
      get: (id) =>
        Effect.gen(function* () {
          yield* ensured;
          const row = yield* inWorker(
            db
              .prepare("SELECT * FROM proposals WHERE id = ?")
              .bind(id)
              .first<Row>(),
          );
          return row === null ? undefined : fromRow(row);
        }),
      resolve: (id, resolution) =>
        Effect.gen(function* () {
          yield* ensured;
          const result = yield* inWorker(
            db
              .prepare(
                `UPDATE proposals SET status = ?, resolved_at = ?, result = ?, error = ?, reason = ?
                 WHERE id = ? AND status = 'pending'`,
              )
              .bind(
                resolution.status,
                Date.now(),
                resolution.status === "accepted" ? resolution.result : null,
                resolution.status === "failed" ? resolution.error : null,
                resolution.status === "rejected"
                  ? (resolution.reason ?? null)
                  : null,
                id,
              )
              .run(),
          );
          return result.meta.changes > 0;
        }),
    });
  }),
);
