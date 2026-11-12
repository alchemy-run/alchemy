import type * as Domain from "@alchemy.run/domain";
import type { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";

/** One money movement on an account, as the ledger table stores it and clients read it. */
export const LedgerRow = Schema.Struct({
  /** `${stream}:${seq}`: the event it came from, so a replay upserts the same row. */
  id: Schema.String,
  accountId: Schema.String,
  kind: Schema.String,
  amount: Cents,
  balanceAfter: Cents,
  /** Epoch milliseconds. */
  at: Schema.Number,
});
export type LedgerRow = typeof LedgerRow.Type;

/** Where a page ends: rows sort by `at`, then `id`. */
export const cursorOf = (row: LedgerRow) => `${row.at}:${row.id}`;

/** The `at` and `id` a cursor names. */
export const parseCursor = (cursor: string) => {
  const split = cursor.indexOf(":");
  return { at: Number(cursor.slice(0, split)), id: cursor.slice(split + 1) };
};

/**
 * Where the ledger lives. The projection writes through this port and the
 * AccountLedger query reads through it, so a story runs both against memory
 * and the server against D1.
 */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    readonly record: (rows: ReadonlyArray<LedgerRow>) => Effect.Effect<void, never, RuntimeContext>;
    /** One page of an account's movements, oldest first. */
    readonly forAccount: (
      accountId: string,
      page: Domain.Query.PageRequest,
    ) => Effect.Effect<Domain.Query.Page<LedgerRow>, never, RuntimeContext>;
  }
>()("Bank/LedgerStore") {}

/** A ledger in memory, for stories and tests. */
export const memoryLedger = () => {
  const table = new Map<string, LedgerRow>();
  return Layer.succeed(LedgerStore, {
    record: (rows) =>
      Effect.sync(() => {
        for (const row of rows) if (!table.has(row.id)) table.set(row.id, row);
      }),
    forAccount: (accountId, { after, take }) =>
      Effect.sync(() => {
        const from = after === undefined ? undefined : parseCursor(after);
        const rows = [...table.values()]
          .filter((row) => row.accountId === accountId)
          .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .filter((row) => !from || row.at > from.at || (row.at === from.at && row.id > from.id));
        const entries = rows.slice(0, take);
        return { entries, cursor: rows.length > take ? cursorOf(entries[take - 1]!) : null };
      }),
  });
};

/** A fresh ledger in memory each time it is built. */
export const MemoryLedgerStore = Layer.suspend(memoryLedger);
