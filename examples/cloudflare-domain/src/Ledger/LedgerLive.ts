import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Ledger } from "./Ledger.ts";
import { LedgerStore } from "./LedgerStore.ts";

/** Writes each batch of an account's movements in one database round-trip. */
export const LedgerLive = Ledger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    return Effect.fn(function* (batch) {
      yield* store.record(
        batch.map(({ key, event, envelope }) => ({
          id: `${envelope.stream}:${envelope.seq}`,
          accountId: key.id,
          kind: event._tag,
          amount: event.amount,
          balanceAfter: event.balanceAfter,
          at: DateTime.toEpochMillis(envelope.at),
        })),
      );
    });
  }),
  { batch: { size: 100, wait: "1 second" } },
);
