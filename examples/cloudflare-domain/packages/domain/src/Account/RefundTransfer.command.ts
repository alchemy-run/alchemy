import * as Domain from "@alchemy.run/domain";
import { Amount, Cents } from "../Money.ts";
import { TransferId } from "../Transfer/Transfer.id.ts";
import { AccountId } from "./Account.id.ts";

export class TransferRefunded extends Domain.Event("TransferRefunded", {
  transferId: TransferId,
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** A refund reached an account that is no longer open. */
export class RefundStranded extends Domain.Event("RefundStranded", {
  transferId: TransferId,
  amount: Cents,
}) {}

/** Reports a fact that already happened, so it never rejects. */
export class RefundTransfer extends Domain.Command("RefundTransfer", {
  input: { accountId: AccountId, transferId: TransferId, amount: Amount },
  events: [TransferRefunded, RefundStranded],
}) {}
