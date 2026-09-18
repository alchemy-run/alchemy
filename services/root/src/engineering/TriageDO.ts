import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import { Triage } from "./Triage.ts";

/**
 * ENGINEERING's Durable Object — ONE instance (`main`) holding the
 * team's inbound DEDUPE (webhooks redeliver, the dev poller
 * re-synthesizes; the manager's SESSION is the queue — the driver
 * owns ordering, durability, waking, and the channel's stop button
 * owns the flow). Work itself lives as THREADS in the channel
 * (ChatDO) — there is no ledger beside them. One SQLite database,
 * one single-threaded turn per verb.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS delivered (
    key TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS pending (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL
  )`,
];

interface EngineeringRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly delivered: (
    key: string,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly pend: (
    event: string,
  ) => Effect.Effect<number, never, RuntimeContext>;
  readonly claim: () => Effect.Effect<
    ReadonlyArray<string>,
    never,
    RuntimeContext
  >;
}

const TriageDOLive = Cloudflare.DurableObject<EngineeringRpc>()(
  "TriageDO",
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

      return {
        delivered: Effect.fn(function* (key) {
          const seen = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT COUNT(*) AS n FROM delivered WHERE key = ?",
            key,
          )).toArray();
          if ((seen[0]?.n ?? 0) > 0) return true;
          yield* sql.exec("INSERT INTO delivered (key) VALUES (?)", key);
          return false;
        }),

        // the BATCHER's ledger: arrivals pend; whoever claims first
        // (the N-trigger or the debounce sleeper) drains atomically —
        // the DO's single-threaded turn IS the lock
        pend: Effect.fn(function* (event) {
          yield* sql.exec("INSERT INTO pending (event) VALUES (?)", event);
          const rows = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT COUNT(*) AS n FROM pending")).toArray();
          return rows[0]?.n ?? 0;
        }),

        claim: Effect.fn(function* () {
          const rows = yield* (yield* sql.exec<
            { event: string } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT event FROM pending ORDER BY seq")).toArray();
          yield* sql.exec("DELETE FROM pending");
          return rows.map((row) => row.event);
        }),
      } satisfies EngineeringRpc;
    });
  }),
);

/** The ONE engineering instance's name. */
const MAIN = "main";

/** The {@link Triage} facade over the one TriageDO. */
export const TriageLive: Layer.Layer<Triage, never, Cloudflare.Worker> =
  Layer.effect(
    Triage,
    Effect.gen(function* () {
      const namespace = yield* TriageDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Triage.of({
        delivered: (key) => inWorker(stub().delivered(key)),
        pend: (event) => inWorker(stub().pend(event)),
        claim: () => inWorker(stub().claim()),
      });
    }),
  );
