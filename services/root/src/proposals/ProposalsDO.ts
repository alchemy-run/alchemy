import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import {
  Proposals,
  type Proposal,
  type ProposalKind,
  type ProposalPayload,
  type ProposalStatus,
  type StageProposalInput,
} from "./Proposals.ts";

/**
 * The PROPOSALS' Durable Object — ONE instance (`main`) for the whole
 * company: every staged external write and the gating policy, in one
 * SQLite database. Small state; the UI reads rows on demand (a card
 * fetches its proposal's live status), so there is no socket.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    payload TEXT NOT NULL,
    proposer_term TEXT NOT NULL,
    proposer_key TEXT NOT NULL,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS policy (
    kind TEXT PRIMARY KEY,
    gated INTEGER NOT NULL
  )`,
];

interface ProposalRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  kind: string;
  status: string;
  summary: string;
  detail: string;
  payload: string;
  proposer_term: string;
  proposer_key: string;
  outcome: string | null;
  created_at: number;
  decided_at: number | null;
}

const toProposal = (row: ProposalRow): Proposal => ({
  id: row.id,
  kind: row.kind as ProposalKind,
  status: row.status as ProposalStatus,
  summary: row.summary,
  detail: row.detail,
  payload: JSON.parse(row.payload) as ProposalPayload,
  proposer: { term: row.proposer_term, key: row.proposer_key },
  ...(row.outcome === null ? {} : { outcome: row.outcome }),
  createdAt: row.created_at,
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
});

interface ProposalsRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly stage: (
    input: StageProposalInput,
  ) => Effect.Effect<Proposal, never, RuntimeContext>;
  readonly read: (
    id: string,
  ) => Effect.Effect<Proposal | undefined, never, RuntimeContext>;
  readonly list: (
    status?: ProposalStatus,
  ) => Effect.Effect<ReadonlyArray<Proposal>, never, RuntimeContext>;
  readonly mark: (
    id: string,
    status: Exclude<ProposalStatus, "pending">,
    outcome?: string,
  ) => Effect.Effect<Proposal | undefined, never, RuntimeContext>;
  readonly gated: (
    kind: ProposalKind,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly setPolicy: (
    kind: ProposalKind,
    gated: boolean,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly policy: () => Effect.Effect<
    ReadonlyArray<{ readonly kind: ProposalKind; readonly gated: boolean }>,
    never,
    RuntimeContext
  >;
}

const ProposalsDOLive = Cloudflare.DurableObject<ProposalsRpc>()(
  "ProposalsDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    const byId = Effect.fn(function* (id: string) {
      const cursor = yield* sql.exec<ProposalRow>(
        "SELECT * FROM proposals WHERE id = ?",
        id,
      );
      const row = (yield* cursor.toArray())[0];
      return row === undefined ? undefined : toProposal(row);
    });

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );

      return {
        stage: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          const id = `p-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          yield* sql.exec(
            `INSERT INTO proposals
            (id, kind, status, summary, detail, payload, proposer_term,
             proposer_key, created_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
            id,
            input.kind,
            input.summary,
            input.detail,
            JSON.stringify(input.payload),
            input.proposer.term,
            input.proposer.key,
            at,
          );
          return (yield* byId(id))!;
        }),

        read: Effect.fn(function* (id) {
          return yield* byId(id);
        }),

        list: Effect.fn(function* (status) {
          const cursor =
            status === undefined
              ? yield* sql.exec<ProposalRow>(
                  "SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200",
                )
              : yield* sql.exec<ProposalRow>(
                  "SELECT * FROM proposals WHERE status = ? ORDER BY created_at ASC",
                  status,
                );
          return (yield* cursor.toArray()).map(toProposal);
        }),

        mark: Effect.fn(function* (id, status, outcome) {
          const current = yield* byId(id);
          if (current === undefined) return undefined;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE proposals SET status = ?, outcome = ?, decided_at = ? WHERE id = ?",
            status,
            outcome ?? current.outcome ?? null,
            at,
            id,
          );
          return yield* byId(id);
        }),

        // policy: unset means GATED — safety is the default; widening a
        // kind is the humans' explicit act
        gated: Effect.fn(function* (kind) {
          const cursor = yield* sql.exec<
            { gated: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT gated FROM policy WHERE kind = ?", kind);
          const row = (yield* cursor.toArray())[0];
          return row === undefined ? true : row.gated === 1;
        }),

        setPolicy: Effect.fn(function* (kind, gated) {
          yield* sql.exec(
            "INSERT OR REPLACE INTO policy (kind, gated) VALUES (?, ?)",
            kind,
            gated ? 1 : 0,
          );
        }),

        policy: Effect.fn(function* () {
          const kinds: ReadonlyArray<ProposalKind> = [
            "comment",
            "push",
            "open_pull",
            "merge",
            "close",
          ];
          const cursor = yield* sql.exec<
            { kind: string; gated: number } & Record<
              string,
              Cloudflare.SqlStorageValue
            >
          >("SELECT kind, gated FROM policy");
          const set = new Map(
            (yield* cursor.toArray()).map((row) => [row.kind, row.gated === 1]),
          );
          return kinds.map((kind) => ({ kind, gated: set.get(kind) ?? true }));
        }),
      } satisfies ProposalsRpc;
    });
  }),
);

/** The ONE proposals instance's name. */
const MAIN = "main";

/**
 * The {@link Proposals} facade over the one ProposalsDO. Requires the
 * host `Worker`: yielding the Durable Object while this Layer builds
 * declares it as a binding of the Worker whose bundle carries its
 * class.
 */
export const ProposalsLive: Layer.Layer<Proposals, never, Cloudflare.Worker> =
  Layer.effect(
    Proposals,
    Effect.gen(function* () {
      const namespace = yield* ProposalsDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Proposals.of({
        stage: (input) => inWorker(stub().stage(input)),
        read: (id) => inWorker(stub().read(id)),
        list: (status) => inWorker(stub().list(status)),
        mark: (id, status, outcome) =>
          inWorker(stub().mark(id, status, outcome)),
        gated: (kind) => inWorker(stub().gated(kind)),
        setPolicy: (kind, gated) => inWorker(stub().setPolicy(kind, gated)),
        policy: () => inWorker(stub().policy()),
      });
    }),
  );
