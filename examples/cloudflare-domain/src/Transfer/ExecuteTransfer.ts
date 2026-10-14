import * as Domain from "alchemy/Domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Activity, DurableDeferred, Workflow } from "effect/workflow";
import { Account } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { CreditTransfer } from "../Account/CreditTransfer.ts";
import { DebitTransfer } from "../Account/DebitTransfer.ts";
import { Frozen } from "../Account/Frozen.ts";
import { InsufficientFunds } from "../Account/InsufficientFunds.ts";
import { NotOpen } from "../Account/NotOpen.ts";
import { NotOwner } from "../Account/NotOwner.ts";
import { RefundTransfer } from "../Account/RefundTransfer.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { CompleteTransfer } from "./CompleteTransfer.ts";
import { FailTransfer } from "./FailTransfer.ts";
import { Transfer } from "./Transfer.ts";
import { TransferId } from "./TransferId.ts";

/** The destination account isn't open, so the money can't arrive. */
export class DestinationClosed extends Domain.Rejection("DestinationClosed") {}

/**
 * What the Transfer decided about a large transfer: an agent approved it, or
 * its approval window closed first.
 */
export const Decision = DurableDeferred.make("decision", {
  success: Schema.Literals(["approved", "expired"]),
});

/**
 * Moves money between two accounts on behalf of the requester: waits for the
 * Transfer to decide a large transfer, debits the source, credits the
 * destination, and refunds the debit if the credit fails. The outcome is
 * recorded on the Transfer either way.
 */
export class ExecuteTransfer extends Domain.Saga("ExecuteTransfer", {
  key: TransferId,
  input: {
    from: AccountId,
    to: AccountId,
    amount: Cents,
    requestedBy: Actor,
    needsApproval: Schema.Boolean,
  },
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds, DestinationClosed],
}) {}

/** Why a transfer failed, in the words the Transfer records. */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const rejection = cause.reasons.find((reason) => reason._tag === "Fail");
  const error =
    rejection?._tag === "Fail" ? (rejection.error as { readonly _tag: string }) : undefined;
  switch (error?._tag) {
    case "NotOpen":
      return "source account not open";
    case "NotOwner":
      return "not your account";
    case "Frozen":
      return `source frozen: ${(error as Frozen).reason}`;
    case "InsufficientFunds":
      return "insufficient funds";
    case "DestinationClosed":
      return "destination account not open";
    default:
      return "interrupted";
  }
};

export const ExecuteTransferLive = ExecuteTransfer.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    const transfers = yield* Transfer;

    return Effect.fn(function* ({ key, from, to, amount, requestedBy, needsApproval }) {
      // Registered first, so it runs last: after any compensations.
      yield* Workflow.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Activity.make({
              name: "record-failure",
              execute: transfers.send(key, new FailTransfer({ reason: reasonOf(exit.cause) })),
            }).pipe(Effect.orDie),
      );

      if (needsApproval) {
        // The Transfer decides between approval and expiry; nothing to do if it expired.
        if ((yield* DurableDeferred.await(Decision)) === "expired") return;
      }

      // Debit first: if the credit fails, the money is refunded, so it's never created.
      yield* Activity.make({
        name: "debit",
        error: Schema.Union([NotOpen, NotOwner, Frozen, InsufficientFunds]),
        execute: accounts.send(from, new DebitTransfer({ transferId: key, amount, requestedBy })),
      }).pipe(
        ExecuteTransfer.withCompensation(() =>
          Activity.make({
            name: "refund",
            execute: accounts.send(from, new RefundTransfer({ transferId: key, amount })),
          }),
        ),
      );

      yield* Activity.make({
        name: "credit",
        error: DestinationClosed,
        execute: accounts
          .send(to, new CreditTransfer({ transferId: key, amount }))
          .pipe(Effect.catchTag("NotOpen", () => Effect.fail(new DestinationClosed()))),
      });

      yield* Activity.make({
        name: "complete",
        execute: transfers.send(key, new CompleteTransfer()),
      });
    });
  }),
);
