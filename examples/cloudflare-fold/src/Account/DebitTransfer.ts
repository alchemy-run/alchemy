import { Command, Event } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { Frozen } from "./Frozen.ts";
import { InsufficientFunds } from "./InsufficientFunds.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class TransferDebited extends Event.make("TransferDebited", {
  data: { transferId: TransferId, amount: Cents, balanceAfter: Cents },
}) {}

/** Take a transfer's amount out of the source account, on behalf of the requester. */
export class DebitTransfer extends Command.make("DebitTransfer", {
  input: { transferId: TransferId, amount: Cents, by: Actor },
  events: [TransferDebited],
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds],
}) {}
