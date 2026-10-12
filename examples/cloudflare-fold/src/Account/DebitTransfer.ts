import { Command, Event } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { AccountId } from "./AccountId.ts";
import { Frozen } from "./Frozen.ts";
import { InsufficientFunds } from "./InsufficientFunds.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class TransferDebited extends Event.make("TransferDebited", {
  data: { transferId: TransferId, amount: Cents, balanceAfter: Cents },
}) {}

/**
 * Take a transfer's amount out of the source account, if the transfer's
 * requester may. Sent by `TransferExecution`; who requested the transfer is a
 * fact recorded on it, so it is input rather than request context.
 */
export class DebitTransfer extends Command.make("DebitTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents, requestedBy: Actor },
  events: [TransferDebited],
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds],
}) {}
