/**
 * The ISSUES Durable Object — ONE instance (`main`) holding every
 * repo's issues, mirrored pulls, and comments (Issues.ts). One
 * SQLite database, one single-threaded turn per verb; the mirror's
 * upserts are idempotent by primary key.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import {
  Issues,
  type CommentRow,
  type CreateIssueInput,
  type IssueRow,
  type ListIssuesQuery,
  type UpdateIssueInput,
} from "./Issues.ts";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS issues (
    repo        TEXT    NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    body        TEXT,
    state       TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    labels      TEXT    NOT NULL,
    is_pull     INTEGER NOT NULL DEFAULT 0,
    head_ref    TEXT,
    base_ref    TEXT,
    merged      INTEGER NOT NULL DEFAULT 0,
    draft       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    origin      TEXT    NOT NULL,
    PRIMARY KEY (repo, number)
  )`,
  `CREATE TABLE IF NOT EXISTS issue_comments (
    repo         TEXT    NOT NULL,
    issue_number INTEGER NOT NULL,
    id           INTEGER NOT NULL,
    author       TEXT    NOT NULL,
    body         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    origin       TEXT    NOT NULL,
    PRIMARY KEY (repo, id)
  )`,
  `CREATE INDEX IF NOT EXISTS issue_comments_by_issue
     ON issue_comments (repo, issue_number, created_at)`,
];

interface IssueDbRow extends Record<string, Cloudflare.SqlStorageValue> {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  labels: string;
  is_pull: number;
  head_ref: string | null;
  base_ref: string | null;
  merged: number;
  draft: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  origin: string;
}

interface CommentDbRow extends Record<string, Cloudflare.SqlStorageValue> {
  repo: string;
  issue_number: number;
  id: number;
  author: string;
  body: string;
  created_at: number;
  updated_at: number;
  origin: string;
}

const toIssue = (row: IssueDbRow): IssueRow => ({
  repo: row.repo,
  number: row.number,
  title: row.title,
  body: row.body,
  state: row.state as IssueRow["state"],
  author: row.author,
  labels: JSON.parse(row.labels) as ReadonlyArray<string>,
  isPull: row.is_pull === 1,
  headRef: row.head_ref,
  baseRef: row.base_ref,
  merged: row.merged === 1,
  draft: row.draft === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at,
  origin: row.origin as IssueRow["origin"],
});

const toComment = (row: CommentDbRow): CommentRow => ({
  repo: row.repo,
  issueNumber: row.issue_number,
  id: row.id,
  author: row.author,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  origin: row.origin as CommentRow["origin"],
});

interface IssuesRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly upsertIssues: (
    rows: ReadonlyArray<IssueRow>,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly upsertComments: (
    rows: ReadonlyArray<CommentRow>,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly get: (
    repo: string,
    number: number,
  ) => Effect.Effect<IssueRow | undefined, never, RuntimeContext>;
  readonly list: (
    repo: string,
    query: ListIssuesQuery,
  ) => Effect.Effect<ReadonlyArray<IssueRow>, never, RuntimeContext>;
  readonly listComments: (
    repo: string,
    issueNumber: number,
  ) => Effect.Effect<ReadonlyArray<CommentRow>, never, RuntimeContext>;
  readonly commentCounts: (
    repo: string,
    numbers: ReadonlyArray<number>,
  ) => Effect.Effect<Readonly<Record<number, number>>, never, RuntimeContext>;
  readonly create: (
    input: CreateIssueInput,
  ) => Effect.Effect<IssueRow, never, RuntimeContext>;
  readonly update: (
    repo: string,
    number: number,
    patch: UpdateIssueInput,
  ) => Effect.Effect<IssueRow | undefined, never, RuntimeContext>;
  readonly addComment: (
    repo: string,
    issueNumber: number,
    input: { readonly author: string; readonly body: string },
  ) => Effect.Effect<CommentRow | undefined, never, RuntimeContext>;
  readonly counts: (
    repo: string,
  ) => Effect.Effect<
    { issues: number; pulls: number; comments: number },
    never,
    RuntimeContext
  >;
}

const IssuesDOLive = Cloudflare.DurableObject<IssuesRpc>()(
  "IssuesDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );

      const upsertIssue = Effect.fn(function* (row: IssueRow) {
        yield* sql.exec(
          `INSERT INTO issues
             (repo, number, title, body, state, author, labels, is_pull,
              head_ref, base_ref, merged, draft, created_at, updated_at,
              closed_at, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, number) DO UPDATE SET
             title = excluded.title, body = excluded.body,
             state = excluded.state, author = excluded.author,
             labels = excluded.labels, is_pull = excluded.is_pull,
             head_ref = excluded.head_ref, base_ref = excluded.base_ref,
             merged = excluded.merged, draft = excluded.draft,
             updated_at = excluded.updated_at,
             closed_at = excluded.closed_at`,
          row.repo,
          row.number,
          row.title,
          row.body,
          row.state,
          row.author,
          JSON.stringify(row.labels),
          row.isPull ? 1 : 0,
          row.headRef,
          row.baseRef,
          row.merged ? 1 : 0,
          row.draft ? 1 : 0,
          row.createdAt,
          row.updatedAt,
          row.closedAt,
          row.origin,
        );
      });

      const readIssue = Effect.fn(function* (repo: string, number: number) {
        const rows = yield* (yield* sql.exec<IssueDbRow>(
          `SELECT * FROM issues WHERE repo = ? AND number = ?`,
          repo,
          number,
        )).toArray();
        return rows[0] === undefined ? undefined : toIssue(rows[0]);
      });

      return {
        upsertIssues: Effect.fn(function* (rows) {
          yield* Effect.forEach(rows, upsertIssue, { discard: true });
        }),

        upsertComments: Effect.fn(function* (rows) {
          yield* Effect.forEach(
            rows,
            (row) =>
              sql
                .exec(
                  `INSERT INTO issue_comments
                     (repo, issue_number, id, author, body, created_at,
                      updated_at, origin)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (repo, id) DO UPDATE SET
                     body = excluded.body, updated_at = excluded.updated_at`,
                  row.repo,
                  row.issueNumber,
                  row.id,
                  row.author,
                  row.body,
                  row.createdAt,
                  row.updatedAt,
                  row.origin,
                )
                .pipe(Effect.asVoid),
            { discard: true },
          );
        }),

        get: readIssue,

        list: Effect.fn(function* (repo, query) {
          const state_ = query.state ?? "open";
          const kind = query.kind ?? "all";
          const perPage = Math.min(Math.max(query.perPage ?? 50, 1), 100);
          const offset = (Math.max(query.page ?? 1, 1) - 1) * perPage;
          const rows = yield* (yield* sql.exec<IssueDbRow>(
            `SELECT * FROM issues
             WHERE repo = ?
               AND (? = 'all' OR state = ?)
               AND (? = 'all' OR is_pull = ?)
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
            repo,
            state_,
            state_,
            kind,
            kind === "pull" ? 1 : 0,
            perPage,
            offset,
          )).toArray();
          return rows.map(toIssue);
        }),

        listComments: Effect.fn(function* (repo, issueNumber) {
          const rows = yield* (yield* sql.exec<CommentDbRow>(
            `SELECT * FROM issue_comments
             WHERE repo = ? AND issue_number = ?
             ORDER BY created_at ASC`,
            repo,
            issueNumber,
          )).toArray();
          return rows.map(toComment);
        }),

        commentCounts: Effect.fn(function* (repo, numbers) {
          if (numbers.length === 0) return {};
          const rows = yield* (yield* sql.exec<
            { issue_number: number; n: number } & Record<
              string,
              Cloudflare.SqlStorageValue
            >
          >(
            `SELECT issue_number, COUNT(*) AS n FROM issue_comments
             WHERE repo = ? GROUP BY issue_number`,
            repo,
          )).toArray();
          const wanted = new Set(numbers);
          const counts: Record<number, number> = {};
          for (const row of rows) {
            if (wanted.has(row.issue_number)) counts[row.issue_number] = row.n;
          }
          return counts;
        }),

        create: Effect.fn(function* (input) {
          // above the high-water mark: mirrored GitHub numbers and
          // local ones share one sequence and never collide
          const max = yield* (yield* sql.exec<
            { n: number | null } & Record<string, Cloudflare.SqlStorageValue>
          >(
            `SELECT MAX(number) AS n FROM issues WHERE repo = ?`,
            input.repo,
          )).toArray();
          const number = (max[0]?.n ?? 0) + 1;
          const now = Date.now();
          const row: IssueRow = {
            repo: input.repo,
            number,
            title: input.title,
            body: input.body ?? null,
            state: "open",
            author: input.author,
            labels: input.labels ?? [],
            isPull: false,
            headRef: null,
            baseRef: null,
            merged: false,
            draft: false,
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            origin: "local",
          };
          yield* upsertIssue(row);
          return row;
        }),

        update: Effect.fn(function* (repo, number, patch) {
          const existing = yield* readIssue(repo, number);
          if (existing === undefined) return undefined;
          const now = Date.now();
          const next: IssueRow = {
            ...existing,
            title: patch.title ?? existing.title,
            body: patch.body === undefined ? existing.body : patch.body,
            state: patch.state ?? existing.state,
            labels: patch.labels ?? existing.labels,
            updatedAt: now,
            closedAt:
              patch.state === "closed"
                ? (existing.closedAt ?? now)
                : patch.state === "open"
                  ? null
                  : existing.closedAt,
          };
          yield* upsertIssue(next);
          return next;
        }),

        addComment: Effect.fn(function* (repo, issueNumber, input) {
          const issue = yield* readIssue(repo, issueNumber);
          if (issue === undefined) return undefined;
          // local ids are NEGATIVE — they can never collide with
          // GitHub's (positive) comment ids in the mirror
          const min = yield* (yield* sql.exec<
            { n: number | null } & Record<string, Cloudflare.SqlStorageValue>
          >(
            `SELECT MIN(id) AS n FROM issue_comments WHERE repo = ? AND id < 0`,
            repo,
          )).toArray();
          const id = Math.min(min[0]?.n ?? 0, 0) - 1;
          const now = Date.now();
          const row: CommentRow = {
            repo,
            issueNumber,
            id,
            author: input.author,
            body: input.body,
            createdAt: now,
            updatedAt: now,
            origin: "local",
          };
          yield* sql.exec(
            `INSERT INTO issue_comments
               (repo, issue_number, id, author, body, created_at,
                updated_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            row.repo,
            row.issueNumber,
            row.id,
            row.author,
            row.body,
            row.createdAt,
            row.updatedAt,
            row.origin,
          );
          return row;
        }),

        counts: Effect.fn(function* (repo) {
          const issues = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            `SELECT COUNT(*) AS n FROM issues WHERE repo = ? AND is_pull = 0`,
            repo,
          )).toArray();
          const pulls = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            `SELECT COUNT(*) AS n FROM issues WHERE repo = ? AND is_pull = 1`,
            repo,
          )).toArray();
          const comments = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            `SELECT COUNT(*) AS n FROM issue_comments WHERE repo = ?`,
            repo,
          )).toArray();
          return {
            issues: issues[0]?.n ?? 0,
            pulls: pulls[0]?.n ?? 0,
            comments: comments[0]?.n ?? 0,
          };
        }),
      } satisfies IssuesRpc;
    });
  }),
);

/** The ONE issues instance's name. */
const MAIN = "main";

/** The {@link Issues} facade over the one IssuesDO. */
export const IssuesLive: Layer.Layer<Issues, never, Cloudflare.Worker> =
  Layer.effect(
    Issues,
    Effect.gen(function* () {
      const namespace = yield* IssuesDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Issues.of({
        upsertIssues: (rows) => inWorker(stub().upsertIssues(rows)),
        upsertComments: (rows) => inWorker(stub().upsertComments(rows)),
        get: (repo, number) => inWorker(stub().get(repo, number)),
        list: (repo, query) => inWorker(stub().list(repo, query)),
        listComments: (repo, issueNumber) =>
          inWorker(stub().listComments(repo, issueNumber)),
        commentCounts: (repo, numbers) =>
          inWorker(stub().commentCounts(repo, numbers)),
        create: (input) => inWorker(stub().create(input)),
        update: (repo, number, patch) =>
          inWorker(stub().update(repo, number, patch)),
        addComment: (repo, issueNumber, input) =>
          inWorker(stub().addComment(repo, issueNumber, input)),
        counts: (repo) => inWorker(stub().counts(repo)),
      });
    }),
  );
