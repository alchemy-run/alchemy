import { Command, Event, Rejection } from "alchemy/Fold";
import { AccountId } from "../Account/AccountId.ts";
import { Actor } from "../Actor.ts";
import { CustomerSession } from "../CustomerApi/CustomerSession.ts";
import { MfaChallenge } from "../CustomerApi/MfaChallenge.ts";
import { Cents } from "../Money.ts";
import { TransferId } from "./TransferId.ts";

export class AlreadyRequested extends Rejection.make("AlreadyRequested") {}

export class SameAccount extends Rejection.make("SameAccount") {}

export class TransferRequested extends Event.make("TransferRequested", {
  data: {
    transferId: TransferId,
    from: AccountId,
    to: AccountId,
    amount: Cents,
    requestedBy: Actor,
  },
}) {}

/**
 * Ask to move money between two accounts; `TransferExecution` carries it out
 * on behalf of the requester. The client picks the transfer id, so a retry
 * is idempotent.
 */
export class RequestTransfer extends Command.make("RequestTransfer", {
  target: TransferId,
  input: { from: AccountId, to: AccountId, amount: Cents },
  events: [TransferRequested],
  rejects: [AlreadyRequested, SameAccount],
})
  .middleware(CustomerSession)
  .middleware(MfaChallenge) {}
