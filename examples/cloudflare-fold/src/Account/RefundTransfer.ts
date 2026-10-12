import { Command, Event } from "alchemy/Fold";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { AccountId } from "./AccountId.ts";

export class TransferRefunded extends Event.make("TransferRefunded", {
  data: { transferId: TransferId, amount: Cents, balanceAfter: Cents },
}) {}

/** A refund reached an account that is no longer open. */
export class RefundStranded extends Event.make("RefundStranded", {
  data: { transferId: TransferId, amount: Cents },
}) {}

/** Reports a fact that already happened, so it never rejects. */
export class RefundTransfer extends Command.make("RefundTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents },
  events: [TransferRefunded, RefundStranded],
}) {}
