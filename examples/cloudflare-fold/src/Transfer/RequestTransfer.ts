import { Command, Event, Rejection } from "alchemy/Fold";
import { AccountId } from "../Account/AccountId.ts";
import { Actor } from "../Actor.ts";
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

/** Ask to move money between two accounts; `TransferExecution` carries it out. */
export class RequestTransfer extends Command.make("RequestTransfer", {
  input: { from: AccountId, to: AccountId, amount: Cents, by: Actor },
  events: [TransferRequested],
  rejects: [AlreadyRequested, SameAccount],
}) {}
