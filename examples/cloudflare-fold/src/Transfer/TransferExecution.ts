import { Policy } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account, CreditTransfer, DebitTransfer, RefundTransfer } from "../Account/Account.ts";
import { CompleteTransfer, FailTransfer, Transfer, TransferRequested } from "./Transfer.ts";

/**
 * Drives a transfer: debit the source on behalf of the requester, credit the
 * destination, then complete, or compensate and fail.
 */
export class TransferExecution extends Policy.make("TransferExecution", {
  from: Transfer,
  on: [TransferRequested],
}) {}

export const TransferExecutionLive = TransferExecution.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    const transfers = yield* Transfer;
    return Effect.fn(function* ({ source, event: { transferId, from, to, amount, requestedBy } }) {
      const fail = (reason: string) =>
        transfers.send(source, new FailTransfer({ reason })).pipe(Effect.as(false));

      // `by: requestedBy` makes Account.decide check that the requester owns the source account.
      const debited = yield* accounts
        .send(from, new DebitTransfer({ transferId, amount, by: requestedBy }))
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            NotOpen: () => fail("source account not open"),
            NotOwner: () => fail("not your account"),
            Frozen: (r) => fail(`source frozen: ${r.reason}`),
            InsufficientFunds: () => fail("insufficient funds"),
          }),
        );
      if (!debited) return;

      yield* accounts.send(to, new CreditTransfer({ transferId, amount })).pipe(
        Effect.andThen(transfers.send(source, new CompleteTransfer())),
        Effect.asVoid,
        Effect.catchTag("NotOpen", () =>
          accounts
            .send(from, new RefundTransfer({ transferId, amount }))
            .pipe(Effect.andThen(fail("destination account not open")), Effect.asVoid),
        ),
      );
    });
  }),
);
