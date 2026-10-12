import { Command, Event } from "alchemy/Fold";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { NotOpen } from "./NotOpen.ts";

export class TransferCredited extends Event.make("TransferCredited", {
  data: { transferId: TransferId, amount: Cents, balanceAfter: Cents },
}) {}

/** Pay a transfer's amount into the destination account. */
export class CreditTransfer extends Command.make("CreditTransfer", {
  input: { transferId: TransferId, amount: Cents },
  events: [TransferCredited],
  rejects: [NotOpen],
}) {}
