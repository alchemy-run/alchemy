import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Activity, Workflow } from "effect/workflow";
import { Account } from "../Account/Account.aggregate.ts";
import { AccountId } from "../Account/Account.id.ts";
import { CreditTransfer } from "../Account/CreditTransfer.command.ts";
import { DebitTransfer } from "../Account/DebitTransfer.command.ts";
import { InsufficientFunds } from "../Account/InsufficientFunds.rejection.ts";
import { NotOpen } from "../Account/NotOpen.rejection.ts";
import { NotOwner } from "../Account/NotOwner.rejection.ts";
import { RefundTransfer } from "../Account/RefundTransfer.command.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { CompleteTransfer } from "./CompleteTransfer.command.ts";
import { FailTransfer } from "./FailTransfer.command.ts";
import { Transfer } from "./Transfer.aggregate.ts";
import { TransferId } from "./Transfer.id.ts";

/** The destination account isn't open, so the money can't arrive. */
export class DestinationClosed extends Domain.Rejection("DestinationClosed") {}

/**
 * Moves money between two accounts on behalf of the requester: debits the
 * source, credits the destination, and refunds the debit if the credit
 * fails. The outcome is recorded on the Transfer either way.
 */
export class ExecuteTransfer extends Domain.Saga("ExecuteTransfer", {
  key: TransferId,
  input: { from: AccountId, to: AccountId, amount: Cents, requestedBy: Actor },
  rejects: [NotOpen, NotOwner, InsufficientFunds, DestinationClosed],
}) {}

/** Why a transfer failed, in the words the Transfer records. */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail");
  const tag =
    failure?._tag === "Fail" ? (failure.error as { readonly _tag: string })._tag : undefined;
  switch (tag) {
    case "NotOpen":
      return "source account not open";
    case "NotOwner":
      return "not your account";
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

    return Effect.fn(function* ({ key, from, to, amount, requestedBy }) {
      // Registered first, so it runs last: after any compensations.
      yield* Workflow.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Activity.make({
              name: "record-failure",
              execute: transfers.send(key, new FailTransfer({ reason: reasonOf(exit.cause) })),
            }).pipe(Effect.orDie),
      );

      // Debit first: if the credit fails, the money is refunded, so it's never created.
      yield* Activity.make({
        name: "debit",
        error: Schema.Union([NotOpen, NotOwner, InsufficientFunds]),
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
