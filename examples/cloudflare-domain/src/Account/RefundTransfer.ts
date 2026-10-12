import * as Domain from "alchemy/Domain";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { AccountId } from "./AccountId.ts";

export class TransferRefunded extends Domain.Event("TransferRefunded", {
  data: { transferId: TransferId, amount: Cents, balanceAfter: Cents },
}) {}

/** A refund reached an account that is no longer open. */
export class RefundStranded extends Domain.Event("RefundStranded", {
  data: { transferId: TransferId, amount: Cents },
}) {}

/** Reports a fact that already happened, so it never rejects. */
export class RefundTransfer extends Domain.Command("RefundTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents },
  events: [TransferRefunded, RefundStranded],
}) {}
