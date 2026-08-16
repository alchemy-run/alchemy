import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The answer to an `offer`: `accepted` — first sighting of `(queue,
 * key)`, the caller creates the run (`send`); `duplicate` — already
 * admitted (a webhook redelivery, a poll re-observation, or a live
 * run's conversation moving), the caller steers.
 *
 * OPEN QUESTION (factory-components.md §3.1 finding 2, deliberately
 * not built yet): the canon's re-admission door (settled key ⇒ new
 * fold-seeded run) needs `offer` to report "settled" DISTINCTLY from
 * "duplicate" — a three-valued answer (`accepted | duplicate |
 * settled`). All three physics below already persist settlement, so
 * widening the union is a contract change only; the re-admission test
 * decides it when that slice lands.
 */
export type OfferStatus = "accepted" | "duplicate";

/**
 * The Ledger — the org's BOOK OF RECORD, its own `Context.Service`
 * with per-environment physics (the components doctrine: environments
 * are Layer provide-lists over seams). It holds the durable facts the
 * org itself creates:
 *
 * - **deliveries** (`offer`/`settle`) — the dedupe/liveness seam:
 *   however many times the world re-delivers, exactly one caller sees
 *   `accepted`;
 * - **metadata** (`put`/`get`) — a generic keyed store for
 *   coordination facts born structured in one place and read in
 *   another (e.g. OpenPullRequest records which issue a PR resolves;
 *   the event router looks it up). Key conventions belong to the
 *   CALLERS — the Ledger stays domain-blind.
 *
 * Process implementations only ever `yield* Ledger`; which physics
 * answers is decided entirely at composition:
 *
 * - `LedgerMemory` (LedgerMemory.ts) — tests.
 * - `LedgerSqlite` (LedgerSqlite.ts) — the laptop: restart-resume (kill
 *   the factory, restart it, re-polled deliveries collapse against the
 *   same file and coordination metadata survives). Its OWN module:
 *   `bun:sqlite` must never enter the Worker bundle.
 * - `LedgerD1` (LedgerD1.ts) — Cloudflare: any number of concurrent
 *   Worker instances agree through the D1 transaction, never instance
 *   memory. Its own module for the same hygiene, mirrored.
 *
 * It is deliberately NOT a task queue: no claim/lease, no visibility
 * timeout, no ordering — ordering and per-key serialization are the
 * kernel Layer's job, retry is `Effect.retry` at the call site (see
 * the factory-components design: keep the name Ledger).
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    /**
     * Transactionally idempotent by `(queue, key)`: however many
     * concurrent instances run this code and however many times the
     * world re-delivers, exactly one caller sees `accepted`.
     */
    offer(
      queue: string,
      key: string,
      task: unknown,
    ): Effect.Effect<{ status: OfferStatus }>;
    /**
     * Record that the run for `(queue, key)` settled (the world closed
     * the work). Idempotent no-op for an unknown key — the
     * delete-idempotency doctrine, same as resource `delete`.
     */
    settle(queue: string, key: string): Effect.Effect<void>;
    /**
     * Stash a coordination fact under `key` (last write wins). JSON
     * values only — the store is durable and environment-portable.
     */
    put(key: string, value: unknown): Effect.Effect<void>;
    /** The fact under `key`, when the org has one on record. */
    get(key: string): Effect.Effect<unknown>;
  }
>()("alchemy-org/Ledger") {}

/** The tables, shared by the sqlite and D1 physics (one dialect). */
export const LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS ledger (
    queue      TEXT NOT NULL,
    key        TEXT NOT NULL,
    task       TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (queue, key)
  )
`;

export const META_TABLE = `
  CREATE TABLE IF NOT EXISTS meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  )
`;
