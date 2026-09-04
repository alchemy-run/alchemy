import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import {
  type Proposal,
  type ProposalPayload,
  type ProposalResolution,
  type ProposalStatus,
  Proposals,
  proposalNumber,
} from "./Proposals.ts";

/**
 * Proposals on Durable Objects — PARTITIONED BY PULL REQUEST.
 *
 * A proposal concerns one pull request (`owner/repo#N`), and so does
 * everything that happens to it: the reviewer revises its draft on
 * every push, the operator accepts or declines it, a close withdraws
 * whatever still waits. One Durable Object per pull request holds
 * those rows — the writes of one pull request never queue behind
 * another's, and the population scales with the number of pull
 * requests, not with one database's write throughput (D1 is a single
 * writer; a DO namespace is as many as there are keys).
 *
 * Two namespaces, one store:
 *
 * - `ProposalPartitions` — one instance per partition. The partition
 *   is the pull request (`owner/repo#N`); a proposal for a pull
 *   request that does not exist yet (the Engineer's `pull_request`
 *   payload) partitions on the repository alone. The instance holds
 *   the full rows (payloads included) and is the source of truth.
 * - `ProposalsIndex` — one instance, holding the FILTER fields only
 *   (`repo`, `number`, `session`, `status`, `at`) for every proposal,
 *   so the operator's inbox and the reviewer's "what of mine still
 *   waits" resolve to ids without scanning partitions. A list is the
 *   index's answer fanned out to the partitions it names, in parallel.
 *
 * The id CARRIES its partition (`proposal-{partition}-{uuid}`, the
 * partition base64url-encoded), so `get`/`revise`/`resolve` route
 * straight to the owning instance — no lookup, no index on the hot
 * path. The index is written AFTER the partition: a proposal is real
 * the moment its partition has it, and at worst briefly unlisted.
 */

// ---------------------------------------------------------------------------
// partitions
// ---------------------------------------------------------------------------

/** The partition a proposal belongs to: its pull request, or — for a
 *  pull request not yet opened — its repository. */
export const partitionOf = (
  repo: string,
  number: number | undefined,
): string => (number === undefined ? repo : `${repo}#${number}`);

const encodePartition = (partition: string): string =>
  btoa(partition).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const decodePartition = (encoded: string): string =>
  atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));

export const mintId = (partition: string): string =>
  `proposal-${encodePartition(partition)}-${crypto.randomUUID()}`;

/** `proposal-{partition}-{uuid}` → the partition; `undefined` for an
 *  id this store never minted (the answer to `get` is then "unknown"). */
export const partitionOfId = (id: string): string | undefined => {
  const match = /^proposal-([A-Za-z0-9_-]+)-([0-9a-f-]{36})$/.exec(id);
  if (match === null) return undefined;
  try {
    return decodePartition(match[1]!);
  } catch {
    return undefined;
  }
};

const PARTITION_TABLE = `
CREATE TABLE IF NOT EXISTS proposals (
  id       TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  proposal TEXT NOT NULL
)`;

interface PartitionRow extends Record<string, Cloudflare.SqlStorageValue> {
  proposal: string;
}

interface PartitionRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly insert: (
    proposal: Proposal,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly revise: (
    id: string,
    input: { readonly summary: string; readonly payload: ProposalPayload },
  ) => Effect.Effect<Proposal | undefined, never, RuntimeContext>;
  readonly resolve: (
    id: string,
    resolution: ProposalResolution,
  ) => Effect.Effect<Proposal | undefined, never, RuntimeContext>;
  readonly get: (
    id: string,
  ) => Effect.Effect<Proposal | undefined, never, RuntimeContext>;
  /** The named rows, in the order asked for; unknown ids are skipped. */
  readonly rows: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Proposal>, never, RuntimeContext>;
}

const PartitionsLive = Cloudflare.DurableObject<PartitionRpc>()(
  "ProposalPartitions",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;
    // the constructor also runs at PLAN time against a mock state, so
    // the table is ensured lazily, once, on the first request
    const ensured = yield* Effect.cached(
      sql
        .exec(PARTITION_TABLE.trim().replaceAll(/\s+/g, " "))
        .pipe(Effect.asVoid),
    );

    const read = (id: string) =>
      Effect.gen(function* () {
        yield* ensured;
        const cursor = yield* sql.exec<PartitionRow>(
          "SELECT proposal FROM proposals WHERE id = ?",
          id,
        );
        const rows = yield* cursor.toArray();
        const row = rows[0];
        return row === undefined
          ? undefined
          : (JSON.parse(row.proposal) as Proposal);
      });

    const write = (proposal: Proposal) =>
      Effect.gen(function* () {
        yield* ensured;
        yield* sql.exec(
          "INSERT OR REPLACE INTO proposals (id, at, proposal) VALUES (?, ?, ?)",
          proposal.id,
          proposal.at,
          JSON.stringify(proposal),
        );
      });

    /** Apply `change` to a PENDING row; the row after, or `undefined`
     *  when it is unknown or already resolved. */
    const amend = (
      id: string,
      change: (row: Proposal, now: number) => Proposal,
    ) =>
      Effect.gen(function* () {
        const row = yield* read(id);
        if (row === undefined || row.status !== "pending") return undefined;
        const next = change(row, yield* Clock.currentTimeMillis);
        yield* write(next);
        return next;
      });

    return Effect.gen(function* () {
      return {
        insert: (proposal) => write(proposal),
        revise: (id, input) =>
          amend(id, (row, now) => ({
            ...row,
            summary: input.summary,
            payload: input.payload,
            number: proposalNumber(input.payload),
            revisedAt: now,
          })),
        resolve: (id, resolution) =>
          amend(id, (row, now) => ({
            ...row,
            status: resolution.status,
            resolvedAt: now,
            result:
              resolution.status === "accepted" ? resolution.result : undefined,
            error:
              resolution.status === "failed" ? resolution.error : undefined,
            reason:
              resolution.status === "rejected" ? resolution.reason : undefined,
          })),
        get: (id) => read(id),
        rows: (ids) =>
          Effect.gen(function* () {
            if (ids.length === 0) return [];
            yield* ensured;
            const cursor = yield* sql.exec<PartitionRow>(
              `SELECT proposal FROM proposals WHERE id IN (${ids.map(() => "?").join(", ")})`,
              ...ids,
            );
            const rows = yield* cursor.toArray();
            const byId = new Map(
              rows.map((row) => {
                const proposal = JSON.parse(row.proposal) as Proposal;
                return [proposal.id, proposal] as const;
              }),
            );
            return ids.flatMap((id) => {
              const proposal = byId.get(id);
              return proposal === undefined ? [] : [proposal];
            });
          }),
      } satisfies PartitionRpc;
    });
  }),
);

// ---------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------

/** The one index instance's name. */
const INDEX = "index";

/** The listing's horizon — resolved proposals older than this drop
 *  out of the UI (they stay in their partitions as the record). */
const LIST_LIMIT = 200;

const INDEX_TABLE = `
CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  partition    TEXT NOT NULL,
  session_term TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER,
  status       TEXT NOT NULL,
  at           INTEGER NOT NULL
)`;

interface IndexEntry {
  readonly id: string;
  readonly partition: string;
  readonly session: { readonly term: string; readonly key: string };
  readonly repo: string;
  readonly number: number | undefined;
  readonly status: ProposalStatus;
  readonly at: number;
}

interface IndexRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  partition: string;
}

type ListFilter = NonNullable<Parameters<Proposals["Service"]["list"]>[0]>;

interface IndexRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly insert: (
    entry: IndexEntry,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly update: (
    id: string,
    patch: {
      readonly number?: number | undefined;
      readonly status?: ProposalStatus;
    },
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** Newest first, capped — the ids the filter selects, each with the
   *  partition that holds its row. */
  readonly list: (
    filter: ListFilter,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly partition: string }>,
    never,
    RuntimeContext
  >;
}

const IndexLive = Cloudflare.DurableObject<IndexRpc>()(
  "ProposalsIndex",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;
    const ensured = yield* Effect.cached(
      sql.exec(INDEX_TABLE.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
    );

    return Effect.gen(function* () {
      return {
        insert: (entry) =>
          Effect.gen(function* () {
            yield* ensured;
            yield* sql.exec(
              `INSERT OR REPLACE INTO proposals (id, partition, session_term, session_key, repo, number, status, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              entry.id,
              entry.partition,
              entry.session.term,
              entry.session.key,
              entry.repo,
              entry.number ?? null,
              entry.status,
              entry.at,
            );
          }),
        update: (id, patch) =>
          Effect.gen(function* () {
            yield* ensured;
            const sets: Array<string> = [];
            const binds: Array<string | number | null> = [];
            if ("number" in patch) {
              sets.push("number = ?");
              binds.push(patch.number ?? null);
            }
            if (patch.status !== undefined) {
              sets.push("status = ?");
              binds.push(patch.status);
            }
            if (sets.length === 0) return;
            yield* sql.exec(
              `UPDATE proposals SET ${sets.join(", ")} WHERE id = ?`,
              ...binds,
              id,
            );
          }),
        list: (filter) =>
          Effect.gen(function* () {
            yield* ensured;
            const where: Array<string> = [];
            const binds: Array<string | number> = [];
            if (filter.repo !== undefined) {
              where.push("repo = ?");
              binds.push(filter.repo);
            }
            if (filter.number !== undefined) {
              where.push("number = ?");
              binds.push(filter.number);
            }
            if (filter.status !== undefined) {
              where.push("status = ?");
              binds.push(filter.status);
            }
            if (filter.session !== undefined) {
              where.push("session_term = ? AND session_key = ?");
              binds.push(filter.session.term, filter.session.key);
            }
            const cursor = yield* sql.exec<IndexRow>(
              `SELECT id, partition FROM proposals${
                where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
              } ORDER BY at DESC LIMIT ${LIST_LIMIT}`,
              ...binds,
            );
            return yield* cursor.toArray();
          }),
      } satisfies IndexRpc;
    });
  }),
);

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

/**
 * The {@link Proposals} store over the two namespaces above. Requires
 * the host `Worker`: yielding the Durable Objects while this Layer
 * builds is what declares them as bindings of the Worker whose bundle
 * carries their classes.
 */
export const ProposalsDO: Layer.Layer<Proposals, never, Cloudflare.Worker> =
  Layer.effect(
    Proposals,
    Effect.gen(function* () {
      const partitions = yield* PartitionsLive;
      const index = yield* IndexLive;
      const partition = (name: string) => partitions.getByName(name);
      const indexStub = () => index.getByName(INDEX);
      // the RPC stubs are RuntimeContext-colored; this Layer is the one
      // place that knows its calls run inside Worker/DO handlers
      const rpc = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
        inWorker(effect);

      return Proposals.of({
        propose: (input) =>
          Effect.gen(function* () {
            const number = proposalNumber(input.payload);
            const where = partitionOf(input.repo, number);
            const proposal: Proposal = {
              id: mintId(where),
              session: input.session,
              repo: input.repo,
              number,
              summary: input.summary,
              payload: input.payload,
              at: yield* Clock.currentTimeMillis,
              revisedAt: undefined,
              status: "pending",
              resolvedAt: undefined,
              result: undefined,
              error: undefined,
              reason: undefined,
            };
            yield* rpc(partition(where).insert(proposal));
            yield* rpc(
              indexStub().insert({
                id: proposal.id,
                partition: where,
                session: proposal.session,
                repo: proposal.repo,
                number: proposal.number,
                status: proposal.status,
                at: proposal.at,
              }),
            );
            return proposal;
          }),
        revise: (id, input) =>
          Effect.gen(function* () {
            const where = partitionOfId(id);
            if (where === undefined) return false;
            const revised = yield* rpc(partition(where).revise(id, input));
            if (revised === undefined) return false;
            yield* rpc(indexStub().update(id, { number: revised.number }));
            return true;
          }),
        list: (filter) =>
          Effect.gen(function* () {
            const entries = yield* rpc(indexStub().list(filter ?? {}));
            const byPartition = new Map<string, Array<string>>();
            for (const entry of entries) {
              const ids = byPartition.get(entry.partition) ?? [];
              ids.push(entry.id);
              byPartition.set(entry.partition, ids);
            }
            const groups = yield* Effect.forEach(
              byPartition,
              ([where, ids]) => rpc(partition(where).rows(ids)),
              { concurrency: "unbounded" },
            );
            return groups.flat().sort((a, b) => b.at - a.at);
          }),
        get: (id) =>
          Effect.gen(function* () {
            const where = partitionOfId(id);
            if (where === undefined) return undefined;
            return yield* rpc(partition(where).get(id));
          }),
        resolve: (id, resolution) =>
          Effect.gen(function* () {
            const where = partitionOfId(id);
            if (where === undefined) return false;
            const resolved = yield* rpc(
              partition(where).resolve(id, resolution),
            );
            if (resolved === undefined) return false;
            yield* rpc(indexStub().update(id, { status: resolved.status }));
            return true;
          }),
      });
    }),
  );
