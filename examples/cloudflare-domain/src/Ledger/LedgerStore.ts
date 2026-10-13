import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LedgerDatabase } from "./LedgerDatabase.ts";

/** One money movement on an account, as the ledger table stores it. */
export interface LedgerRow {
  /** `${stream}:${seq}`: the event it came from, so a replay upserts the same row. */
  readonly id: string;
  readonly accountId: string;
  readonly kind: string;
  readonly amount: number;
  readonly balanceAfter: number;
  /** Epoch milliseconds. */
  readonly at: number;
}

/**
 * Where the ledger lives. The projection depends on this, not on D1, so a
 * story can run it against memory.
 */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    readonly record: (rows: ReadonlyArray<LedgerRow>) => Effect.Effect<void, never, RuntimeContext>;
    readonly forAccount: (
      accountId: string,
    ) => Effect.Effect<ReadonlyArray<LedgerRow>, never, RuntimeContext>;
  }
>()("Bank/LedgerStore") {}

/** The ledger in D1. */
export const D1LedgerStore = Layer.effect(
  LedgerStore,
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(yield* LedgerDatabase);
    return {
      record: (rows) =>
        rows.length === 0
          ? Effect.void
          : db
              .batch(
                rows.map((row) =>
                  db
                    .prepare(
                      "INSERT INTO ledger (id, account_id, kind, amount, balance_after, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
                    )
                    .bind(row.id, row.accountId, row.kind, row.amount, row.balanceAfter, row.at),
                ),
              )
              .pipe(Effect.asVoid),
      forAccount: (accountId) =>
        db
          .prepare(
            "SELECT id, account_id AS accountId, kind, amount, balance_after AS balanceAfter, at FROM ledger WHERE account_id = ? ORDER BY at, id",
          )
          .bind(accountId)
          .all<LedgerRow>()
          .pipe(Effect.map((result) => result.results)),
    };
  }),
);

/** A ledger in memory, for stories and tests: its Layer, and a reader for assertions. */
export const memoryLedger = () => {
  const table = new Map<string, LedgerRow>();
  const forAccount = (accountId: string) =>
    Effect.sync(() => [...table.values()].filter((row) => row.accountId === accountId));
  return {
    layer: Layer.succeed(LedgerStore, {
      record: (rows) =>
        Effect.sync(() => {
          for (const row of rows) if (!table.has(row.id)) table.set(row.id, row);
        }),
      forAccount,
    }),
    forAccount,
  };
};

/** A fresh ledger in memory each time it is built. */
export const MemoryLedgerStore = Layer.suspend(() => memoryLedger().layer);
